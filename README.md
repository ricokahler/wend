# wend

Typed, composable HTTP routing for `(req, res)` and `Request`/`Response` handlers.

```ts
import { createNodeHandler, handler, notFound } from '@ricokahler/wend/node';

const app = createNodeHandler((route) =>
  route
    .match({ path: '/users/:id', method: 'GET' }, handler(({ route, res }) => {
      res.json({ id: route.params.id }); // route.params.id is typed as string
    }))
    .serve(notFound()),
);

http.createServer(app).listen(3000);
```

The same router on Cloudflare Workers, Deno, or Bun — the builder is identical; you return a `Response` instead of mutating `res`:

```ts
import { createFetchHandler, handler, notFound } from '@ricokahler/wend/fetch';

const app = createFetchHandler((route) =>
  route
    .match({ path: '/users/:id', method: 'GET' }, handler(({ route }) =>
      Response.json({ id: route.params.id }),
    ))
    .serve(notFound()),
);

export default { fetch: app };
```

## Install

```bash
npm install @ricokahler/wend
```

Requires Node 18+ (for the Fetch globals). No build step, no codegen. One runtime dependency: [`path-to-regexp`](https://github.com/pillarjs/path-to-regexp).

## The idea

A handler is a function over a context object. `wend` gives you one immutable
builder to compose those handlers with three things tracked at the type level:

- **Context accumulation** — each `.with(...)` step extends the typed context that downstream handlers receive.
- **Path params** — inferred from the path string. `'/users/:id'` gives you `route.params.id: string`, no annotation.
- **Nested routes** — mount sub-trees; child routes see the accumulated context and parent params.

The core is runtime-agnostic. You pick an adapter:

- **`@ricokahler/wend/node`** — handlers respond by mutating `res`. Runs on `node:http`, Express, Next.js (pages API), Fastify (raw), Google Cloud Functions.
- **`@ricokahler/wend/fetch`** — handlers return a `Response`. Runs on Cloudflare Workers, Deno, Bun, Next.js (App Router).

The builder (`.with`, `.match`, `.serve`), the param inference, and the
middleware model are the same in both. Only how a handler emits a response
differs, and each adapter is native to its runtime — no request/response
conversion either way.

## Node / Express

```ts
import express from 'express';
import { createNodeHandler, handler, notFound } from '@ricokahler/wend/node';

const app = createNodeHandler((route) =>
  route
    .match({ path: '/health', method: 'GET' }, handler(({ res }) => {
      res.writeHead(200);
      res.end('ok');
    }))
    .match({ path: '/users/:id', method: 'GET' }, handler(({ route, res }) => {
      res.json({ id: route.params.id }); // res.json works when running under Express
    }))
    .serve(notFound()),
);

const server = express();
server.use(app);
server.listen(3000);
```

A Node handler returns nothing; you write to `res`. Its return value is ignored,
so chainable calls (`res.json(x)`) and `async` handlers both work.

## Cloudflare Workers, Deno, Bun

```ts
import { createFetchHandler, handler, notFound } from '@ricokahler/wend/fetch';

const app = createFetchHandler((route) =>
  route
    .match({ path: '/health', method: 'GET' }, handler(() => new Response('ok')))
    .match({ path: '/users/:id', method: 'GET' }, handler(({ route }) =>
      Response.json({ id: route.params.id }),
    ))
    .serve(notFound()),
);

export default { fetch: app };      // Cloudflare Workers
// Deno.serve(app);                 // Deno
// Bun.serve({ fetch: app });       // Bun
// export const GET = app;          // Next.js App Router
```

A Fetch handler returns a `Response`. `async` handlers return `Promise<Response>`.

## Typed path params

Params are read from the path string at the type level:

```ts
route.match({ path: '/orgs/:orgId/users/:userId', method: 'GET' }, handler(({ route }) => {
  route.params.orgId;  // string
  route.params.userId; // string
}));
```

- `:name` → `string`
- `*name` → `string[]` (wildcard / splat)
- `{name}` → optional, becomes `string | undefined`

## Middleware

Two kinds, both type-safe. **Context middleware** with `extend` returns fields
that are merged into the context and visible (and typed) downstream:

```ts
import { createNodeHandler, extend, handler, notFound } from '@ricokahler/wend/node';

const auth = extend(async ({ req }) => ({
  user: await authenticate(req), // ctx.user is now typed downstream
}));

const app = createNodeHandler((route) =>
  route
    .with(auth)
    .match({ path: '/me', method: 'GET' }, handler(({ user, res }) => {
      res.json({ id: user.id });
    }))
    .serve(notFound()),
);
```

**Wrapper middleware** with `middleware` wraps execution — for CORS, timing, or
logging. On `@ricokahler/wend/fetch` it can transform the returned `Response`:

```ts
import { middleware } from '@ricokahler/wend/fetch';

const cors = middleware((next) => async (ctx) => {
  if (ctx.routing.method === 'OPTIONS') return new Response(null, { status: 204 });
  const res = await next(ctx);
  res.headers.set('access-control-allow-origin', '*');
  return res;
});
```

Middleware composes with `.with(...)` and applies in declaration order.

## Nested routes

`define` names a reusable sub-tree. Params and context accumulate through
nesting, and each sub-tree can have its own fallback:

```ts
import { createNodeHandler, define, handler, notFound, type Router } from '@ricokahler/wend/node';

const users = define<Router.Context<{ orgId: string }>>((route) =>
  route
    .match({ path: '/:userId', method: 'GET' }, handler(({ route, res }) => {
      // route.params has both orgId (from parent) and userId
      res.json({ orgId: route.params.orgId, userId: route.params.userId });
    }))
    .serve(notFound('user route not found')),
);

const app = createNodeHandler((route) =>
  route
    .match({ path: '/orgs/:orgId/users' }, users)
    .serve(notFound()),
);
```

## Errors

Throw from any handler or middleware; the adapter's error boundary renders it:

```ts
import { httpError, notFound } from '@ricokahler/wend/node';

handler(({ route }) => {
  if (!route.params.id) throw httpError(400, { error: 'id required' }); // → 400 with that body
  throw notFound()();                                                    // → 404
  throw new Error('boom');                                               // → 500
});
```

`createNodeHandler` / `createFetchHandler` take an `onError` callback, invoked
only for unexpected (500) failures — the place to log or report:

```ts
createFetchHandler(routes, {
  onError: (error, ctx) => reportToSentry(error, { path: ctx.routing.pathname }),
});
```

## API

Imported from `@ricokahler/wend/node` or `@ricokahler/wend/fetch` (both expose the same names, typed for
their runtime):

| Export | Description |
| --- | --- |
| `createNodeHandler(def, opts?)` | Build `(req, res) => Promise<void>`. `opts`: `onError`, `getRouting`. |
| `createFetchHandler(def, opts?)` | Build `(request) => Promise<Response>`. `opts`: `onError`, `getRouting`. |
| `handler(fn)` | A terminal handler. |
| `notFound(message?)` | A fallback that produces a 404. |
| `extend(build)` | Context middleware — merges returned fields into context. |
| `middleware(mw)` | Wrapper middleware — `(next) => (ctx) => ...`. |
| `define(def)` | Name a reusable sub-route tree. |
| `httpError(status, body?)` | Build an error to throw for an explicit status + body. |
| `Router` | The underlying builder + types (`Router.Context`, `Router.InferPathParams`, …). |

`route` builder methods: `.with(middleware)`, `.match(spec, definition)`,
`.serve(fallback)`. `spec` is `{ path: string; method?: HttpMethod }`.

## Compatibility

| Runtime | Adapter |
| --- | --- |
| Cloudflare Workers | `@ricokahler/wend/fetch` |
| Deno (`Deno.serve`) | `@ricokahler/wend/fetch` |
| Bun (`Bun.serve`) | `@ricokahler/wend/fetch` |
| Next.js App Router | `@ricokahler/wend/fetch` |
| `node:http` | `@ricokahler/wend/node` |
| Express | `@ricokahler/wend/node` |
| Next.js pages API | `@ricokahler/wend/node` |
| Fastify (raw) | `@ricokahler/wend/node` |
| Google Cloud Functions | `@ricokahler/wend/node` |

## How it works

Each `.with(...)` and `.match(...)` returns a new `Router` — no mutation, no
ordering surprises. The type parameter tracks accumulated context:

```
Router<{}>
  .with(auth)                      // Router<{ user: User }>
  .match({ path: '/x/:id' }, ...)  // Router<{ user: User }>
  .serve(handler)                  // a composed handler
```

Routes use `path-to-regexp` with prefix matching (`{ end: false }`): `/status`
matches `/status`, `/status/`, and `/status/anything`. Routes are tried in
declaration order; the first match wins. Nest a route and add `.serve(notFound())`
to get exact matching. The remaining pathname after a match is on
`ctx.routing.pathname` inside the matched sub-tree.

`createNodeHandler` / `createFetchHandler` install an error boundary and inject
the base context (`req`, the matched `routing`, and `res` for Node). The router
core itself imports neither `node:http` nor `Response`.

## For AI agents

This package ships docs written for coding agents:

- **`SKILL.md`** — a [Claude Agent Skill](https://docs.claude.com/en/docs/claude-code/skills) that teaches an agent to write `wend` code. For Claude Code, copy it to `.claude/skills/wend/SKILL.md` in your project (or `~/.claude/skills/wend/SKILL.md`).
- **`AGENTS.md`** — repo + usage context for any agent that reads `AGENTS.md` (e.g. Codex). It points to `SKILL.md` for usage patterns.
- **`llms.txt`** — an index of the docs and source.

All three are included in the published package, so an agent working in a
project that depends on `wend` can read them from `node_modules/@ricokahler/wend/`.

## License

MIT © Rico Kahler
