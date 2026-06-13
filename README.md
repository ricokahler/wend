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

Requires Node 18+ (for the Fetch globals). No build step, no codegen — about 800 lines across three files, one runtime dependency ([`path-to-regexp`](https://github.com/pillarjs/path-to-regexp)), and [small enough to read in a sitting](#small-enough-to-read).

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

## Validating input (Zod)

`wend` doesn't bundle a validator — it gives you typed seams to plug one in. A
small helper turns any [Zod](https://zod.dev) schema into a `422` on failure:

```ts
import { z } from 'zod';
import { httpError } from '@ricokahler/wend/fetch';

const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw httpError(422, { error: 'Validation failed', issues: result.error.issues });
  }
  return result.data;
};
```

**Body** — as reusable middleware that exposes a typed `ctx.body`:

```ts
import { createFetchHandler, extend, handler, notFound } from '@ricokahler/wend/fetch';

const body = <T extends z.ZodType>(schema: T) =>
  extend(async ({ req }): Promise<{ body: z.infer<T> }> => ({
    body: parse(schema, await req.json()),
  }));

const NewUser = z.object({ name: z.string().min(1), email: z.string().email() });

const app = createFetchHandler((route) =>
  route
    .with(body(NewUser))
    .match({ path: '/users', method: 'POST' }, handler(({ body }) =>
      Response.json({ created: body.email }), // body: { name: string; email: string }
    ))
    .serve(notFound()),
);
```

**URL params** — they arrive as strings; `z.coerce` turns them into what you want:

```ts
const UserParams = z.object({ id: z.coerce.number().int().positive() });

route.match({ path: '/users/:id', method: 'GET' }, handler(({ route }) => {
  const { id } = parse(UserParams, route.params); // id: number
  return Response.json({ id });
}));
```

**Query string** — same helper, fed from the URL:

```ts
const Query = z.object({ page: z.coerce.number().int().positive().default(1) });

route.match({ path: '/search', method: 'GET' }, handler(({ req }) => {
  const { page } = parse(Query, Object.fromEntries(new URL(req.url).searchParams));
  return Response.json({ page }); // page: number, defaults to 1
}));
```

These use `@ricokahler/wend/fetch`. On `@ricokahler/wend/node` it's the same,
except you read the body off the request stream before `parse(...)`-ing it.

## Composing middleware

Each `.with(...)` adds to the typed context, so the handler at the end sees the
union of everything before it. Stack logging, auth, and body validation — the
types follow through:

```ts
import {
  createFetchHandler, extend, handler, httpError, middleware, notFound,
} from '@ricokahler/wend/fetch';

const log = middleware((next) => async (ctx) => {
  const started = Date.now();
  const res = await next(ctx);
  console.log(`${ctx.routing.method} ${ctx.routing.pathname} → ${res.status} (${Date.now() - started}ms)`);
  return res;
});

const requireAuth = extend(({ req }) => {
  const token = req.headers.get('authorization');
  if (!token) throw httpError(401, { error: 'Unauthorized' }); // short-circuits here
  return { user: { id: token.replace('Bearer ', '') } };
});

const app = createFetchHandler((route) =>
  route
    .with(log)           // wraps every request
    .with(requireAuth)   // adds ctx.user
    .with(body(NewUser)) // adds ctx.body  (from the section above)
    .match({ path: '/users', method: 'POST' }, handler(({ user, body }) =>
      Response.json({ by: user.id, created: body.email }), // user and body both typed
    ))
    .serve(notFound()),
);
```

`requireAuth` throws before the handler runs, so unauthenticated requests never
reach it — and because context accumulates by type, removing `.with(requireAuth)`
turns `ctx.user` into a compile error at the handler.

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

## Small enough to read

The whole library is **~800 lines across three files** — much of it the
compile-time path-param inference and doc comments. One runtime dependency
(`path-to-regexp`). If you like to know what you depend on, it's short enough to
read end to end:

- [`src/index.ts`](src/index.ts) — the builder, the type-level param inference, and the error boundary. Imports nothing runtime-specific.
- [`src/node.ts`](src/node.ts) — the Node adapter (~140 lines).
- [`src/fetch.ts`](src/fetch.ts) — the Fetch adapter (~110 lines).

The `src/` is shipped in the published package too, so it's there in
`node_modules/@ricokahler/wend/` as well.

## For AI agents

This package ships docs written for coding agents:

- **`SKILL.md`** — a [Claude Agent Skill](https://docs.claude.com/en/docs/claude-code/skills) that teaches an agent to write `wend` code. For Claude Code, copy it to `.claude/skills/wend/SKILL.md` in your project (or `~/.claude/skills/wend/SKILL.md`).
- **`AGENTS.md`** — repo + usage context for any agent that reads `AGENTS.md` (e.g. Codex). It points to `SKILL.md` for usage patterns.
- **`llms.txt`** — an index of the docs and source.

All three are included in the published package, so an agent working in a
project that depends on `wend` can read them from `node_modules/@ricokahler/wend/`.

## License

MIT © Rico Kahler
