import { describe, expect, it, vi } from 'vitest';
import {
  createFetchHandler,
  extend,
  handler,
  httpError,
  middleware,
  notFound,
} from '../src/fetch.js';

function request(path: string, method = 'GET', headers?: HeadersInit): Request {
  return new Request(`http://localhost${path}`, { method, headers });
}

describe('wend/fetch', () => {
  it('serves a matched route by returning a Response', async () => {
    const app = createFetchHandler((route) =>
      route
        .match(
          { path: '/users/:id', method: 'GET' },
          handler(({ route }) => Response.json({ id: route.params.id })),
        )
        .serve(notFound()),
    );

    const res = await app(request('/users/abc'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'abc' });
  });

  it('renders notFound misses as 404 JSON', async () => {
    const app = createFetchHandler((route) =>
      route
        .match({ path: '/hello', method: 'GET' }, handler(() => Response.json({})))
        .serve(notFound('nope')),
    );

    const res = await app(request('/missing'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  it('renders unexpected throws as 500 JSON', async () => {
    const app = createFetchHandler((route) =>
      route
        .match(
          { path: '/boom', method: 'GET' },
          handler((): Response => {
            throw new Error('kaboom');
          }),
        )
        .serve(notFound()),
    );

    const res = await app(request('/boom'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'kaboom' });
  });

  it('renders a thrown httpError with its status + body', async () => {
    const app = createFetchHandler((route) =>
      route
        .match(
          { path: '/teapot', method: 'GET' },
          handler((): Response => {
            throw httpError(418, { teapot: true });
          }),
        )
        .serve(notFound()),
    );

    const res = await app(request('/teapot'));
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ teapot: true });
  });

  it('lets wrapper middleware transform the returned Response', async () => {
    const cors = middleware((next) => async (ctx) => {
      if (ctx.routing.method === 'OPTIONS') {
        return new Response(null, { status: 204 });
      }
      const res = await next(ctx);
      res.headers.set('access-control-allow-origin', '*');
      return res;
    });

    const app = createFetchHandler((route) =>
      route
        .with(cors)
        .match({ path: '/data', method: 'GET' }, handler(() => Response.json({ ok: true })))
        .serve(notFound()),
    );

    const preflight = await app(request('/data', 'OPTIONS'));
    expect(preflight.status).toBe(204);

    const res = await app(request('/data'));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('flows context middleware into handlers', async () => {
    const auth = extend(({ req }) => ({
      auth: { token: req.headers.get('authorization') ?? 'anon' },
    }));

    const app = createFetchHandler((route) =>
      route
        .with(auth)
        .match({ path: '/me', method: 'GET' }, handler(({ auth }) => Response.json(auth)))
        .serve(notFound()),
    );

    const res = await app(request('/me', 'GET', { authorization: 'Bearer t' }));
    expect(await res.json()).toEqual({ token: 'Bearer t' });
  });

  it('calls onError once, only for genuine failures', async () => {
    const onError = vi.fn();
    const app = createFetchHandler(
      (route) =>
        route
          .match(
            { path: '/boom', method: 'GET' },
            handler((): Response => {
              throw new Error('real');
            }),
          )
          .serve(notFound()),
      { onError },
    );

    await app(request('/missing')); // 404
    expect(onError).not.toHaveBeenCalled();

    await app(request('/boom'));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
