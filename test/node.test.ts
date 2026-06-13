import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createNodeHandler,
  define,
  extend,
  handler,
  httpError,
  middleware,
  notFound,
  type Router,
} from '../src/node.js';

// ── Minimal node:http mocks ───────────────────────────────────

function createRequest(
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
): IncomingMessage {
  return { url, method, headers } as unknown as IncomingMessage;
}

interface MockResponse extends ServerResponse {
  statusCode: number;
  body: unknown;
}

function createResponse(): MockResponse {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    writableEnded: false,
    _headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
      return res;
    },
    end(data?: string) {
      if (data) res.body = JSON.parse(data);
      res.headersSent = true;
      res.writableEnded = true;
      return res;
    },
  };
  return res as unknown as MockResponse;
}

async function run(
  app: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<MockResponse> {
  const res = createResponse();
  await app(createRequest(url, method, headers), res);
  return res;
}

describe('wend/node', () => {
  it('serves a matched route by mutating res', async () => {
    const app = createNodeHandler((route) =>
      route
        .match(
          { path: '/users/:id', method: 'GET' },
          handler(({ route, res }) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: route.params.id }));
          }),
        )
        .serve(notFound()),
    );

    const res = await run(app, '/users/abc');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'abc' });
  });

  it('renders notFound misses as 404 JSON', async () => {
    const app = createNodeHandler((route) =>
      route
        .match({ path: '/hello', method: 'GET' }, handler(({ res }) => res.end('{}')))
        .serve(notFound('nope')),
    );

    const res = await run(app, '/missing');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'nope' });
  });

  it('renders unexpected throws as 500 JSON', async () => {
    const app = createNodeHandler((route) =>
      route
        .match(
          { path: '/boom', method: 'GET' },
          handler(() => {
            throw new Error('kaboom');
          }),
        )
        .serve(notFound()),
    );

    const res = await run(app, '/boom');
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'kaboom' });
  });

  it('renders a thrown httpError with its status + body', async () => {
    const app = createNodeHandler((route) =>
      route
        .match(
          { path: '/forbidden', method: 'GET' },
          handler(() => {
            throw httpError(403, { error: 'forbidden' });
          }),
        )
        .serve(notFound()),
    );

    const res = await run(app, '/forbidden');
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  it('rethrows when a response was already committed', async () => {
    const app = createNodeHandler((route) =>
      route
        .match(
          { path: '/partial', method: 'GET' },
          handler(({ res }) => {
            res.writeHead(200);
            res.end('{}');
            throw new Error('after end');
          }),
        )
        .serve(notFound()),
    );

    await expect(run(app, '/partial')).rejects.toThrow('after end');
  });

  it('reads Express originalUrl when present', async () => {
    const app = createNodeHandler((route) =>
      route
        .match({ path: '/api/hello', method: 'GET' }, handler(({ res }) => res.end('{"ok":true}')))
        .serve(notFound()),
    );

    const req = createRequest('/hello') as IncomingMessage & { originalUrl?: string };
    req.originalUrl = '/api/hello';
    const res = createResponse();
    await app(req, res);
    expect(res.body).toEqual({ ok: true });
  });

  it('prefers Express res.json/res.status when available', async () => {
    const app = createNodeHandler((route) =>
      route.serve(notFound('gone')),
    );

    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const expressRes = {
      status,
      json,
      headersSent: false,
      writableEnded: false,
    } as unknown as ServerResponse;

    await app(createRequest('/x'), expressRes);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: 'gone' });
  });

  it('calls onError once, only for genuine failures', async () => {
    const onError = vi.fn();
    const app = createNodeHandler(
      (route) =>
        route
          .match(
            { path: '/boom', method: 'GET' },
            handler(() => {
              throw new Error('real');
            }),
          )
          .match(
            { path: '/teapot', method: 'GET' },
            handler(() => {
              throw httpError(418, { teapot: true });
            }),
          )
          .serve(notFound()),
      { onError },
    );

    await run(app, '/missing'); // 404 — not a failure
    await run(app, '/teapot'); // httpError — not a failure
    expect(onError).not.toHaveBeenCalled();

    await run(app, '/boom'); // genuine failure
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('flows reusable middleware + context into nested routes', async () => {
    const auth = extend(({ req }) => ({
      auth: { token: String(req.headers['authorization'] ?? 'anon') },
    }));

    const log = middleware<{}, { auth: { token: string } }>(
      (next) => (ctx) => next(ctx),
    );

    const users = define<{ auth: { token: string } } & Router.Context<{ orgId: string }>>(
      (route) =>
        route
          .match(
            { path: '/:userId', method: 'GET' },
            handler(({ auth, route, res }) => {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  token: auth.token,
                  orgId: route.params.orgId,
                  userId: route.params.userId,
                }),
              );
            }),
          )
          .serve(notFound()),
    );

    const app = createNodeHandler((route) =>
      route
        .with(auth)
        .with(log)
        .match({ path: '/orgs/:orgId/users' }, users)
        .serve(notFound()),
    );

    const res = await run(app, '/orgs/org-1/users/u-9', 'GET', {
      authorization: 'Bearer t',
    });
    expect(res.body).toEqual({ token: 'Bearer t', orgId: 'org-1', userId: 'u-9' });
  });
});
