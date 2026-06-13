import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createFetchHandler,
  extend,
  handler,
  httpError,
  middleware,
  notFound,
} from '../src/fetch.js';

// These tests mirror the recipes in the README verbatim, so the documented
// patterns are guaranteed to compile and run.

function request(
  path: string,
  method = 'GET',
  json?: unknown,
  headers?: HeadersInit,
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

// ── Reusable pieces from the README ───────────────────────────

/** Parse `value` against a schema, or fail with a 422. */
const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw httpError(422, { error: 'Validation failed', issues: result.error.issues });
  }
  return result.data;
};

/** Middleware: validate the JSON body, expose a typed `ctx.body`. */
const body = <T extends z.ZodType>(schema: T) =>
  extend(async ({ req }): Promise<{ body: z.infer<T> }> => ({
    body: parse(schema, await req.json()),
  }));

/** Middleware: require a bearer token, expose a typed `ctx.user`. */
const requireAuth = extend(({ req }) => {
  const token = req.headers.get('authorization');
  if (!token) throw httpError(401, { error: 'Unauthorized' });
  return { user: { id: token.replace('Bearer ', '') } };
});

/** Wrapper middleware: record method/path/status. */
const log = (events: string[]) =>
  middleware((next) => async (ctx) => {
    const res = await next(ctx);
    events.push(`${ctx.routing.method} ${ctx.routing.pathname} ${res.status}`);
    return res;
  });

// ── Tests ─────────────────────────────────────────────────────

const NewUser = z.object({ name: z.string().min(1), email: z.string().email() });

describe('recipes — zod validation', () => {
  it('validates the body and exposes it typed', async () => {
    const app = createFetchHandler((route) =>
      route
        .with(body(NewUser))
        .match({ path: '/users', method: 'POST' }, handler(({ body }) =>
          Response.json({ created: body.email }),
        ))
        .serve(notFound()),
    );

    const ok = await app(request('/users', 'POST', { name: 'Ada', email: 'ada@example.com' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ created: 'ada@example.com' });

    const bad = await app(request('/users', 'POST', { name: '', email: 'nope' }));
    expect(bad.status).toBe(422);
  });

  it('coerces and validates URL params', async () => {
    const UserParams = z.object({ id: z.coerce.number().int().positive() });

    const app = createFetchHandler((route) =>
      route
        .match({ path: '/users/:id', method: 'GET' }, handler(({ route }) => {
          const { id } = parse(UserParams, route.params); // id: number
          return Response.json({ id, doubled: id * 2 });
        }))
        .serve(notFound()),
    );

    expect(await (await app(request('/users/21'))).json()).toEqual({ id: 21, doubled: 42 });
    expect((await app(request('/users/-3'))).status).toBe(422);
  });

  it('validates the query string', async () => {
    const Query = z.object({ page: z.coerce.number().int().positive().default(1) });

    const app = createFetchHandler((route) =>
      route
        .match({ path: '/search', method: 'GET' }, handler(({ req }) => {
          const { page } = parse(Query, Object.fromEntries(new URL(req.url).searchParams));
          return Response.json({ page });
        }))
        .serve(notFound()),
    );

    expect(await (await app(request('/search?page=3'))).json()).toEqual({ page: 3 });
    expect(await (await app(request('/search'))).json()).toEqual({ page: 1 });
  });
});

describe('recipes — composition', () => {
  it('stacks logging + auth + body with typed accumulation', async () => {
    const events: string[] = [];

    const app = createFetchHandler((route) =>
      route
        .with(log(events))
        .with(requireAuth)
        .with(body(NewUser))
        .match({ path: '/users', method: 'POST' }, handler(({ user, body }) =>
          Response.json({ by: user.id, created: body.email }),
        ))
        .serve(notFound()),
    );

    const unauth = await app(request('/users', 'POST', { name: 'Ada', email: 'ada@x.com' }));
    expect(unauth.status).toBe(401);

    const ok = await app(
      request('/users', 'POST', { name: 'Ada', email: 'ada@x.com' }, { authorization: 'Bearer u_1' }),
    );
    expect(await ok.json()).toEqual({ by: 'u_1', created: 'ada@x.com' });
    expect(events).toContain('POST /users 200');
  });
});
