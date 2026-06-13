import { describe, expect, it } from 'vitest';
import { Router } from '../src/index.js';

// ── A trivial in-test adapter ─────────────────────────────────
// The core knows nothing about any runtime, so the tests drive it with the
// simplest possible result type: handlers return a string, and errors render
// to strings. This exercises matching, context, middleware, nesting, and the
// error boundary without any node:http or Fetch machinery.

function createStringHandler(
  definition: Router.Definition<{}, string>,
): (method: string, pathname: string) => Promise<string> {
  const boundary = Router.errorBoundary<{}, string>({
    onNotFound: (_ctx, message) => `404:${message}`,
    onHttpError: (_ctx, status, body) => `http:${status}:${JSON.stringify(body)}`,
    onServerError: (_ctx, message) => `500:${message}`,
  });
  const root = boundary(definition(new Router<{}, string>()));
  return (method, pathname) =>
    Promise.resolve(root({ routing: { method, pathname } }));
}

describe('Router — matching', () => {
  it('matches a simple path and method', async () => {
    const run = createStringHandler((route) =>
      route
        .match({ path: '/hello', method: 'GET' }, Router.handler(() => 'hello'))
        .serve(Router.notFound()),
    );

    expect(await run('GET', '/hello')).toBe('hello');
  });

  it('falls through to notFound for unmatched paths', async () => {
    const run = createStringHandler((route) =>
      route
        .match({ path: '/hello', method: 'GET' }, Router.handler(() => 'hello'))
        .serve(Router.notFound()),
    );

    expect(await run('GET', '/nope')).toBe('404:Not found');
  });

  it('does not match when the method differs', async () => {
    const run = createStringHandler((route) =>
      route
        .match({ path: '/hello', method: 'POST' }, Router.handler(() => 'hello'))
        .serve(Router.notFound('no')),
    );

    expect(await run('GET', '/hello')).toBe('404:no');
  });

  it('matches any method when none is specified', async () => {
    const run = createStringHandler((route) =>
      route
        .match({ path: '/any' }, Router.handler(({ routing }) => routing.method))
        .serve(Router.notFound()),
    );

    expect(await run('GET', '/any')).toBe('GET');
    expect(await run('DELETE', '/any')).toBe('DELETE');
  });

  it('uses ordered prefix matching — first match wins', async () => {
    const run = createStringHandler((route) =>
      route
        .match({ path: '/status/history' }, Router.handler(() => 'history'))
        .match(
          { path: '/status' },
          Router.handler(({ routing }) => `status:${routing.pathname}`),
        )
        .serve(Router.notFound()),
    );

    expect(await run('GET', '/status/history')).toBe('history');
    expect(await run('GET', '/status/extra')).toBe('status:/extra');
  });

  it('stops at the first matching route', async () => {
    const calls: string[] = [];
    const run = createStringHandler((route) =>
      route
        .match(
          { path: '/x', method: 'GET' },
          Router.handler(() => {
            calls.push('first');
            return 'first';
          }),
        )
        .match(
          { path: '/x', method: 'GET' },
          Router.handler(() => {
            calls.push('second');
            return 'second';
          }),
        )
        .serve(Router.notFound()),
    );

    expect(await run('GET', '/x')).toBe('first');
    expect(calls).toEqual(['first']);
  });
});

describe('Router — params', () => {
  it('infers and injects named params', async () => {
    const run = createStringHandler((route) =>
      route
        .match(
          { path: '/users/:userId', method: 'GET' },
          Router.handler(({ route }) => route.params.userId),
        )
        .serve(Router.notFound()),
    );

    expect(await run('GET', '/users/abc-123')).toBe('abc-123');
  });

  it('accumulates params through nested branches with parent metadata', async () => {
    const run = createStringHandler((route) =>
      route
        .match({ path: '/campaigns/:campaignId' }, (route) =>
          route
            .match(
              { path: '/sync/:syncId', method: 'POST' },
              Router.handler(({ route }) =>
                JSON.stringify({
                  campaignId: route.params.campaignId,
                  syncId: route.params.syncId,
                  parentPattern: route.parent?.pattern,
                }),
              ),
            )
            .serve(Router.notFound('campaign 404')),
        )
        .serve(Router.notFound()),
    );

    expect(await run('POST', '/campaigns/c-1/sync/s-2')).toBe(
      JSON.stringify({
        campaignId: 'c-1',
        syncId: 's-2',
        parentPattern: '/campaigns/:campaignId',
      }),
    );
  });

  it('uses branch-local notFound for nested misses', async () => {
    const run = createStringHandler((route) =>
      route
        .match({ path: '/campaigns/:campaignId' }, (route) =>
          route
            .match({ path: '/snapshot' }, Router.handler(() => 'snap'))
            .serve(Router.notFound('campaign 404')),
        )
        .serve(Router.notFound('app 404')),
    );

    expect(await run('GET', '/campaigns/c-1/unknown')).toBe('404:campaign 404');
  });

  it('supports Router.define for reusable sub-trees', async () => {
    const admin = Router.define<Router.Context<{ orgId: string }>, string>(
      (route) =>
        route
          .match(
            { path: '/users', method: 'GET' },
            Router.handler(({ route }) => `users:${route.params.orgId}`),
          )
          .serve(Router.notFound()),
    );

    const run = createStringHandler((route) =>
      route.match({ path: '/orgs/:orgId' }, admin).serve(Router.notFound()),
    );

    expect(await run('GET', '/orgs/org-42/users')).toBe('users:org-42');
  });

  it('supports three levels of nesting', async () => {
    const run = createStringHandler((route) =>
      route
        .match({ path: '/a/:aId' }, (route) =>
          route
            .match({ path: '/b/:bId' }, (route) =>
              route
                .match(
                  { path: '/c/:cId', method: 'GET' },
                  Router.handler(({ route }) => JSON.stringify(route.params)),
                )
                .serve(Router.notFound()),
            )
            .serve(Router.notFound()),
        )
        .serve(Router.notFound()),
    );

    expect(await run('GET', '/a/1/b/2/c/3')).toBe(
      JSON.stringify({ aId: '1', bId: '2', cId: '3' }),
    );
  });
});

describe('Router — middleware', () => {
  it('runs middleware in declaration order and accumulates context', async () => {
    const events: string[] = [];

    const trace = Router.middleware<{}, {}, string>((next) => async (ctx) => {
      events.push('before');
      const result = await next(ctx);
      events.push('after');
      return result;
    });

    const tag = Router.extend<{ tag: string }, {}, string>(() => {
      events.push('extend');
      return { tag: 'T' };
    });

    const run = createStringHandler((route) =>
      route
        .with(trace)
        .with(tag)
        .match(
          { path: '/x', method: 'GET' },
          Router.handler(({ tag }) => {
            events.push('handler');
            return tag;
          }),
        )
        .serve(Router.notFound()),
    );

    expect(await run('GET', '/x')).toBe('T');
    expect(events).toEqual(['before', 'extend', 'handler', 'after']);
  });

  it('lets middleware short-circuit without calling next', async () => {
    const guard = Router.middleware<{}, {}, string>((next) => (ctx) => {
      if (ctx.routing.method === 'OPTIONS') return 'preflight';
      return next(ctx);
    });

    const run = createStringHandler((route) =>
      route
        .with(guard)
        .match({ path: '/x', method: 'GET' }, Router.handler(() => 'ok'))
        .serve(Router.notFound()),
    );

    expect(await run('OPTIONS', '/x')).toBe('preflight');
    expect(await run('GET', '/x')).toBe('ok');
  });

  it('composes multiple extend steps', async () => {
    const run = createStringHandler((route) =>
      route
        .with(Router.extend<{ a: string }, {}, string>(() => ({ a: 'A' })))
        .with(Router.extend<{ b: string }, {}, string>(() => ({ b: 'B' })))
        .match(
          { path: '/all', method: 'GET' },
          Router.handler(({ a, b }) => a + b),
        )
        .serve(Router.notFound()),
    );

    expect(await run('GET', '/all')).toBe('AB');
  });
});

describe('Router — error boundary', () => {
  it('renders RouteNotFoundError as onNotFound', async () => {
    const run = createStringHandler((route) =>
      route.serve(Router.notFound('missing')),
    );
    expect(await run('GET', '/x')).toBe('404:missing');
  });

  it('renders thrown HttpError as onHttpError', async () => {
    const run = createStringHandler((route) =>
      route
        .match(
          { path: '/teapot', method: 'GET' },
          Router.handler((): string => {
            throw Router.httpError(418, { teapot: true });
          }),
        )
        .serve(Router.notFound()),
    );
    expect(await run('GET', '/teapot')).toBe('http:418:{"teapot":true}');
  });

  it('renders any other throw as onServerError', async () => {
    const run = createStringHandler((route) =>
      route
        .match(
          { path: '/boom', method: 'GET' },
          Router.handler((): string => {
            throw new Error('kaboom');
          }),
        )
        .serve(Router.notFound()),
    );
    expect(await run('GET', '/boom')).toBe('500:kaboom');
  });
});

describe('Router — immutability', () => {
  it('with() and match() return new routers', () => {
    const base = new Router<{}, string>();
    const extended = base.with(Router.extend<{ a: 1 }, {}, string>(() => ({ a: 1 })));
    const matched = base.match({ path: '/x' }, Router.handler(() => 'x'));

    expect(extended).not.toBe(base);
    expect(matched).not.toBe(base);
    expect(base.routes).toHaveLength(0);
    expect(matched.routes).toHaveLength(1);
  });
});

// ── Type-level tests ──────────────────────────────────────────
// These fail to compile if inference is wrong.

describe('Router — type inference', () => {
  it('extracts named params', () => {
    type Params = Router.InferPathParams<'/users/:userId/posts/:postId'>;
    const check: Params = { userId: 'a', postId: 'b' };
    expect(check).toEqual({ userId: 'a', postId: 'b' });
  });

  it('extracts wildcard params as string[]', () => {
    type Params = Router.InferPathParams<'/files/*path'>;
    const check: Params = { path: ['a', 'b'] };
    expect(check).toEqual({ path: ['a', 'b'] });
  });

  it('mixes named and wildcard params', () => {
    type Params = Router.InferPathParams<'/orgs/:orgId/files/*rest'>;
    const check: Params = { orgId: 'x', rest: ['y'] };
    expect(check).toEqual({ orgId: 'x', rest: ['y'] });
  });

  it('is empty for paramless paths', () => {
    type Params = Router.InferPathParams<'/static/page'>;
    const check: Params = {};
    expect(check).toEqual({});
  });
});
