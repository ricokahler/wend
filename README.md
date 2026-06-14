# wend

[![npm version](https://img.shields.io/npm/v/@ricokahler/wend?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/@ricokahler/wend)
[![CI](https://github.com/ricokahler/wend/actions/workflows/ci.yml/badge.svg)](https://github.com/ricokahler/wend/actions/workflows/ci.yml)
[![gzip size](https://deno.bundlejs.com/badge?q=@ricokahler/wend/fetch)](https://bundlejs.com/?q=%40ricokahler%2Fwend%2Ffetch)
[![types included](https://img.shields.io/npm/types/@ricokahler/wend?logo=typescript&logoColor=white)](src/index.ts)
[![license MIT](https://img.shields.io/npm/l/@ricokahler/wend?color=blue)](LICENSE)

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

Requires Node 18+ (for the Fetch globals). No build step, no codegen, no decorators — about 830 lines across three files, one runtime dependency ([`path-to-regexp`](https://github.com/pillarjs/path-to-regexp)), [~3.3 kB gzipped](#small-enough-to-read), and [small enough to read in a sitting](#small-enough-to-read).

## The idea

A wend app is a **route tree** you build with a small, immutable builder. Three
ideas carry the whole library:

- **Handlers are functions over a context.** Every handler gets one `ctx` — the request, the matched `route` (with typed params), and any fields that middleware added — and responds. That's the entire surface a handler sees.
- **Context accumulates, and the types follow.** Each `.with(...)` step adds typed fields to `ctx` that every downstream handler can read. Path params come for free: `'/users/:id'` gives you `route.params.id: string`, no annotation.
- **You compose, you don't mutate.** `.with(...)`, `.match(...)`, and `.serve(...)` each return a *new* router. Declaration order is the only order — no setup-ordering bugs, no global registration.

The core is runtime-agnostic; you choose an adapter for *how a handler responds*:

- **`@ricokahler/wend/node`** — handlers mutate `res`. Runs on `node:http`, Express, Next.js (pages API), Fastify (raw), Google Cloud Functions.
- **`@ricokahler/wend/fetch`** — handlers return a `Response`. Runs on Cloudflare Workers, Deno, Bun, Next.js (App Router).

The builder, the param inference, and the middleware model are identical in both —
only how a handler emits a response differs, and each adapter is native to its
runtime (no request/response conversion).

The payoff, in short:

- **Typed end to end** — path params *and* middleware context are inferred, never annotated by hand.
- **Ordering checked by the compiler** — a middleware that reads `ctx.user` won't mount before the one that adds it (see [below](#middleware-that-needs-other-middleware)).
- **The same code everywhere** — one builder on Node/Express and on Workers/Deno/Bun, through native adapters.
- **Tiny and dependency-light** — ~3.3 kB gzipped including `path-to-regexp`; one dependency; nothing to generate or compile.

The rest of this README builds up from there: routes → typed params → middleware
→ composition → nested trees → errors → input validation.

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

Paths are matched with [`path-to-regexp`](https://github.com/pillarjs/path-to-regexp)
— the same library Express uses — so the pattern syntax is the one you already
know. wend reads the param names straight out of the path string and types them
for you, with no annotation:

```ts
route.match({ path: '/orgs/:orgId/users/:userId', method: 'GET' }, handler(({ route }) => {
  route.params.orgId;  // string
  route.params.userId; // string
}));
```

- `:name` → `string`
- `*name` → `string[]` (wildcard / splat)
- `{name}` → optional, becomes `string | undefined`

The full `path-to-regexp` syntax is available at runtime; wend infers the common
cases above at the type level.

## Middleware

Middleware is how you add behavior in front of your handlers. There are exactly
**two kinds**, and the names say what they do:

- **`extend` — adds to the context.** You return an object (sync or `async`); its fields are merged into `ctx` and become typed for every handler and middleware *after* it. Reach for `extend` to **produce a value**: the authenticated user, a parsed body, a database handle.
- **`middleware` — wraps execution.** You get `(next) => (ctx) => …` and run code *around* `await next(ctx)`. On the Fetch adapter you can also read or replace the returned `Response`. Reach for `middleware` to **act around a request**: timing, logging, CORS, rate limiting, short-circuiting.

The mental model: `extend` passes data **forward**; `middleware` wraps **around**.
Both are values you create and mount with `.with(...)`, and both apply in
declaration order.

### Write middleware as a factory

**By convention, middleware is a factory — a function that returns the
middleware** — even when it takes no configuration (`() => …`). You always *call*
it at the mount: `.with(auth())`, not `.with(auth)`. It's a one-character habit
with three payoffs: every `.with(...)` gets its own instance, you can pass
configuration as arguments, and you can keep per-instance state private in the
closure.

**Context middleware** (`extend`) — produce typed, request-scoped fields:

```ts
import { createNodeHandler, extend, handler, httpError, notFound } from '@ricokahler/wend/node';

const auth = () =>
  extend(({ req }) => {
    const token = req.headers.get('authorization');
    if (!token) throw httpError(401, { error: 'Unauthorized' });
    const [id, role = 'member'] = token.replace('Bearer ', '').split(':');
    return { user: { id, role } }; // ctx.user is typed downstream
  });

const app = createNodeHandler((route) =>
  route
    .with(auth())
    .match({ path: '/me', method: 'GET' }, handler(({ user, res }) => {
      res.json({ id: user.id, role: user.role });
    }))
    .serve(notFound()),
);
```

**Wrapper middleware** (`middleware`) — wrap execution. Configuration is just an
argument to the factory; here the allowed origin:

```ts
import { middleware } from '@ricokahler/wend/fetch';

const cors = (origin: string) =>
  middleware((next) => async (ctx) => {
    if (ctx.routing.method === 'OPTIONS') return new Response(null, { status: 204 });
    const res = await next(ctx);          // run the rest of the stack
    res.headers.set('access-control-allow-origin', origin);
    return res;                           // …then transform the Response
  });

route.with(cors('https://example.com'));
```

On `@ricokahler/wend/node`, set headers on `ctx.res` before/after `await next(ctx)`
and return nothing.

**State stays private in the closure** — each call to the factory gets its own.
Here's a small in-memory rate limiter; the `hits` map belongs to that one
instance:

```ts
const rateLimit = ({ max, windowMs }: { max: number; windowMs: number }) => {
  const hits = new Map<string, { count: number; resetAt: number }>(); // private per instance

  return middleware((next) => async (ctx) => {
    const key = ctx.req.headers.get('x-forwarded-for') ?? 'anon';
    const now = Date.now();
    const seen = hits.get(key);
    if (!seen || now > seen.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
    } else if (++seen.count > max) {
      return new Response('Too many requests', { status: 429 });
    }
    return next(ctx);
  });
};

route.with(rateLimit({ max: 100, windowMs: 60_000 }));
```

## Middleware that needs other middleware

Because context accumulates *by type*, a middleware can **declare that it depends
on fields an earlier one added** — just by reading them. wend tracks both what a
middleware *adds* and what it *needs*, so the chain is checked at compile time.

`auth()` above adds `ctx.user`. A `requireRole` step depends on it: it reads
`ctx.user.role`, and that read is all it takes to declare the dependency.

```ts
import { extend, httpError } from '@ricokahler/wend/fetch';

// Depends on ctx.user (added by auth). Adds nothing itself.
const requireRole = (role: string) =>
  extend(({ user }: { user: { role: string } }) => {
    if (user.role !== role) throw httpError(403, { error: 'forbidden' });
    return {};
  });
```

A *wrapper* middleware can depend on upstream context too — declare what it needs
with the type argument:

```ts
import { middleware } from '@ricokahler/wend/fetch';

// Depends on ctx.user.id (added by auth) to attribute each request.
const auditLog = () =>
  middleware<{}, { user: { id: string } }>((next) => async (ctx) => {
    const res = await next(ctx);
    console.log(`user ${ctx.user.id}: ${ctx.routing.method} → ${res.status}`);
    return res;
  });
```

Mount them after `auth()` and everything lines up — `ctx.user` exists, fully
typed, by the time each one runs:

```ts
route
  .with(auth())               // adds ctx.user
  .with(requireRole('admin')) // needs ctx.user
  .with(auditLog());          // needs ctx.user.id
```

Get the order wrong and it's a **type error, not a runtime surprise** — wend knows
`requireRole` needs `ctx.user` and won't let it mount before `auth()` provides it:

```ts
route
  .with(requireRole('admin')) // ✗ Type error: ctx.user isn't in context yet
  .with(auth());
```

This is the same mechanism as typed accumulation, used in reverse: `.with(...)`
advances the context to include what a middleware adds, and refuses a middleware
whose needs the current context doesn't already satisfy.

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

The `define<Router.Context<{ orgId: string }>>(...)` type argument declares what
the sub-tree expects from its parent — the same needs/adds idea as middleware,
one level up.

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

**Body** — as reusable middleware that exposes a typed `ctx.body` (note it's an
`async extend` — `extend` accepts a promise):

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
import { createFetchHandler, handler, middleware, notFound } from '@ricokahler/wend/fetch';

const log = () =>
  middleware((next) => async (ctx) => {
    const started = Date.now();
    const res = await next(ctx);
    console.log(`${ctx.routing.method} ${ctx.routing.pathname} → ${res.status} (${Date.now() - started}ms)`);
    return res;
  });

const app = createFetchHandler((route) =>
  route
    .with(log())           // wraps every request
    .with(auth())          // adds ctx.user  (from "Middleware" above)
    .with(body(NewUser))   // adds ctx.body  (body(schema) is itself a factory)
    .match({ path: '/users', method: 'POST' }, handler(({ user, body }) =>
      Response.json({ by: user.id, created: body.email }), // user and body both typed
    ))
    .serve(notFound()),
);
```

`auth()` throws before the handler runs, so unauthenticated requests never reach
it — and because context accumulates by type, removing `.with(auth())` turns
`ctx.user` into a compile error at the handler (and at any middleware that needed
it).

## API

Imported from `@ricokahler/wend/node` or `@ricokahler/wend/fetch` (both expose the same names, typed for
their runtime):

| Export | Description |
| --- | --- |
| `createNodeHandler(def, opts?)` | Build `(req, res) => Promise<void>`. `opts`: `onError`, `getRouting`. |
| `createFetchHandler(def, opts?)` | Build `(request) => Promise<Response>`. `opts`: `onError`, `getRouting`. |
| `handler(fn)` | A terminal handler — receives `ctx`, responds. |
| `notFound(message?)` | A fallback that produces a 404. Use as the last `.serve(...)`. |
| `extend(build)` | Context middleware — merges the returned fields into context. Can read context an earlier `extend` added. |
| `middleware(mw)` | Wrapper middleware — `(next) => (ctx) => ...`. Declare upstream needs via its type argument. |
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

## Under the hood

The whole design is four small decisions, and they're worth knowing because they
explain the ergonomics above:

- **The builder is immutable.** Every `.with(...)` and `.match(...)` returns a new `Router` — nothing is mutated, so declaration order is the only order. A `Router` is just a value: build it, share it, mount it anywhere. No registration side effects, no “did I call this before that” bugs.

  ```
  Router<{}>
    .with(auth())                    // Router<{ user: User }>
    .match({ path: '/x/:id' }, ...)  // Router<{ user: User }>
    .serve(handler)                  // a composed handler
  ```

- **One context object flows through everything.** Middleware and routing share a single `ctx`. A handler's entire world is that object — the request, the matched `route` (with typed params), and whatever middleware added. Nothing hides on `this` or in a global.
- **One type does the heavy lifting.** A middleware is typed `Middleware<TAdds, TNeeds>` — *“I add `TAdds`, I need `TNeeds`.”* `.with(...)` checks the current context satisfies `TNeeds`, then advances it to include `TAdds`. That single idea is what gives you *both* typed accumulation *and* the compile-time ordering check — they're the same rule read in two directions.
- **The core is runtime-agnostic.** `src/index.ts` never imports `node:http` or references `Response`. An adapter supplies a base context (`req`/`res` or `req`) and a set of error responders to `errorBoundary` — that's the whole seam. Supporting a new runtime is one small file.

Routes use `path-to-regexp` with prefix matching (`{ end: false }`): `/status`
matches `/status`, `/status/`, and `/status/anything`. Routes are tried in
declaration order; the first match wins. Nest a route and add `.serve(notFound())`
to get exact matching. After a match, the remaining pathname is on
`ctx.routing.pathname` inside the matched sub-tree.

## Small enough to read

The whole library is **~830 lines across three files** — much of it the
compile-time path-param inference and doc comments — and tree-shakes to about
**3.3 kB gzipped**, `path-to-regexp` included:

[![@ricokahler/wend/fetch gzip size](https://deno.bundlejs.com/badge?q=@ricokahler/wend/fetch)](https://bundlejs.com/?q=%40ricokahler%2Fwend%2Ffetch) `@ricokahler/wend/fetch`
&nbsp;·&nbsp;
[![@ricokahler/wend/node gzip size](https://deno.bundlejs.com/badge?q=@ricokahler/wend/node)](https://bundlejs.com/?q=%40ricokahler%2Fwend%2Fnode) `@ricokahler/wend/node`

One runtime dependency. If you like to know what you depend on, it's short enough
to read end to end:

- [`src/index.ts`](src/index.ts) — the builder, the type-level param inference, and the error boundary. Imports nothing runtime-specific.
- [`src/node.ts`](src/node.ts) — the Node adapter (~150 lines).
- [`src/fetch.ts`](src/fetch.ts) — the Fetch adapter (~120 lines).

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
