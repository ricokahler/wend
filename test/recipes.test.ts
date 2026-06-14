import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createFetchHandler,
  extend,
  handler,
  httpError,
  middleware,
  notFound,
  Router,
  type FetchContext,
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

/** Middleware factory: require a bearer token, expose a typed `ctx.user` (id + role). */
const auth = () =>
  extend(({ req }) => {
    const token = req.headers.get('authorization');
    if (!token) throw httpError(401, { error: 'Unauthorized' });
    const [id, role = 'member'] = token.replace('Bearer ', '').split(':');
    return { user: { id, role } };
  });

/** Middleware factory that *depends on* `ctx.user` (added by `auth`) and checks a role. */
const requireRole = (role: string) =>
  extend(({ user }: { user: { role: string } }) => {
    if (user.role !== role) throw httpError(403, { error: 'forbidden' });
    return {};
  });

/** Wrapper middleware that *depends on* `ctx.user.id` and records an audit line. */
const auditLog = (sink: string[]) =>
  middleware<{}, { user: { id: string } }>((next) => async (ctx) => {
    const res = await next(ctx);
    sink.push(`${ctx.user.id} ${ctx.routing.method} ${res.status}`);
    return res;
  });

/** Middleware factory with private per-instance state: a tiny rate limiter. */
const rateLimit = ({ max }: { max: number }) => {
  const hits = new Map<string, number>(); // private to this instance
  return middleware((next) => async (ctx) => {
    const key = ctx.req.headers.get('x-forwarded-for') ?? 'anon';
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    if (n > max) return new Response('Too many requests', { status: 429 });
    return next(ctx);
  });
};

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
        .with(auth())
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

  it('keeps middleware state private per factory instance', async () => {
    const make = () =>
      createFetchHandler((route) =>
        route
          .with(rateLimit({ max: 2 }))
          .match({ path: '/', method: 'GET' }, handler(() => Response.json({ ok: true })))
          .serve(notFound()),
      );

    const app = make();
    const hit = (a = app) => a(request('/', 'GET', undefined, { 'x-forwarded-for': '1.2.3.4' }));
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429); // third request is over the limit

    // A separate factory instance has its own private `hits` map — not limited.
    expect((await hit(make())).status).toBe(200);
  });

  it('chains middleware that depend on context other middleware added', async () => {
    const audit: string[] = [];

    const app = createFetchHandler((route) =>
      route
        .with(auth()) // adds ctx.user
        .with(requireRole('admin')) // reads ctx.user, added by auth
        .with(auditLog(audit)) // reads ctx.user.id, added by auth
        .match({ path: '/admin', method: 'GET' }, handler(({ user }) =>
          Response.json({ id: user.id, role: user.role }),
        ))
        .serve(notFound()),
    );

    // No token → auth() short-circuits with 401.
    expect((await app(request('/admin'))).status).toBe(401);
    // Wrong role → requireRole() short-circuits with 403.
    expect(
      (await app(request('/admin', 'GET', undefined, { authorization: 'Bearer u_1:member' }))).status,
    ).toBe(403);
    // Admin → 200, and the audit wrapper saw the user it depends on.
    const ok = await app(request('/admin', 'GET', undefined, { authorization: 'Bearer u_1:admin' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: 'u_1', role: 'admin' });
    expect(audit).toEqual(['u_1 GET 200']);
  });

  it('rejects middleware mounted before the context it needs (compile-time)', () => {
    const route = new Router<FetchContext, Response>(); // context has only `req`

    // @ts-expect-error — requireRole needs ctx.user, which nothing has added yet
    route.with(requireRole('admin'));
    // @ts-expect-error — auditLog reads ctx.user.id, also not present yet
    route.with(auditLog([]));

    expect(true).toBe(true); // the real assertions are the two @ts-expect-errors above
  });
});
