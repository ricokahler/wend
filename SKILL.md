---
name: wend
description: Write HTTP routes, middleware, and handlers with the wend router. Use whenever a project depends on `@ricokahler/wend` (imports from `@ricokahler/wend`, `@ricokahler/wend/node`, or `@ricokahler/wend/fetch`) and you are adding, structuring, or editing routes, middleware, path params, nested route trees, or error handling. Covers both the Node adapter (mutate `res`) and the Fetch adapter (return `Response`).
---

# Using wend

`wend` is a typed, immutable HTTP router. You compose handlers with one builder
(`.with` / `.match` / `.serve`); path params are inferred from the path string,
and middleware accumulates typed context. The core is runtime-agnostic — you
import from a runtime adapter.

## 1. Choose the adapter first

Pick based on how the target runtime responds. **Import everything from the
adapter, not from `@ricokahler/wend` directly.**

| Use `@ricokahler/wend/node` | Use `@ricokahler/wend/fetch` |
| --- | --- |
| `node:http`, Express, Next.js pages API, Fastify (raw), Google Cloud Functions | Cloudflare Workers, Deno, Bun, Next.js App Router |
| Handlers **mutate `res`** and return nothing | Handlers **return a `Response`** |
| `createNodeHandler(...) → (req, res) => Promise<void>` | `createFetchHandler(...) → (request) => Promise<Response>` |

The builder, param inference, and middleware model are identical across both.
Only the handler body and the create function differ.

## 2. Mental model

- **Immutable builder.** `.with(mw)` and `.match(spec, def)` each return a *new* router. Build by chaining; declaration order is the matching order.
- **Typed context accumulates.** `.with(auth())` adds fields to `ctx`; every downstream handler sees them, typed. A middleware can also *require* fields an earlier one added — enforced at compile time. (Middleware is a factory — see below.)
- **Params are inferred from the path string.** `'/users/:id'` ⇒ `ctx.route.params.id: string`. No annotation, no generic.
- **Prefix matching, first match wins.** Uses `path-to-regexp` with `{ end: false }`: `'/status'` matches `/status`, `/status/`, and `/status/x`. Put more specific routes first. Nest + `.serve(notFound())` for exact matching.
- **Respond by the adapter's contract.** `@ricokahler/wend/node`: write to `ctx.res` (return value ignored). `@ricokahler/wend/fetch`: `return` a `Response`.

## 3. Core API (import from `@ricokahler/wend/node` or `@ricokahler/wend/fetch`)

- `createNodeHandler(definition, options?)` / `createFetchHandler(definition, options?)` — build the runtime handler. `options`: `{ onError?, getRouting? }`.
- `handler(fn)` — a terminal handler. `fn` receives `ctx`.
- `notFound(message?)` — terminal fallback that yields a 404. Use as the last `.serve(...)`.
- `extend(build)` — context middleware. `build(ctx)` returns an object merged into downstream context (sync or async). Wrap in a factory: `const auth = () => extend(build)`.
- `middleware(mw)` — wrapper middleware: `(next) => (ctx) => ...`. Wrap timing/CORS/logging; on fetch, transform the returned `Response`. Wrap in a factory: `const cors = () => middleware(mw)`.
- `define(definition)` — name a reusable sub-route tree (for nesting / splitting files).
- `httpError(status, body?)` — build an error to `throw` for an explicit status + body.
- `Router` — the underlying builder + types: `Router.Context<P>`, `Router.InferPathParams<S>`, `Router.BaseContext`.

`ctx` always has `ctx.routing` (`{ method, pathname }`) and the adapter's request:
`ctx.req`/`ctx.res` (node) or `ctx.req` (fetch). After a `.match`, `ctx.route`
holds `params`, `pattern`, `pathname`, and `parent`.

## 4. Recipes

### Add a route

Node:
```ts
import { createNodeHandler, handler, notFound } from '@ricokahler/wend/node';

const app = createNodeHandler((route) =>
  route
    .match({ path: '/users/:id', method: 'GET' }, handler(({ route, res }) => {
      res.json({ id: route.params.id }); // Express; or res.writeHead(...)+res.end(...)
    }))
    .serve(notFound()),
);
```

Fetch:
```ts
import { createFetchHandler, handler, notFound } from '@ricokahler/wend/fetch';

const app = createFetchHandler((route) =>
  route
    .match({ path: '/users/:id', method: 'GET' }, handler(({ route }) =>
      Response.json({ id: route.params.id }),
    ))
    .serve(notFound()),
);
```

Omit `method` to match any method. `spec.method` is one of
`GET POST PUT PATCH DELETE OPTIONS HEAD`.

### Middleware — always a factory

Write middleware as a **factory: a function that returns the middleware** — even
with no arguments (`() => …`). Call it at the mount (`.with(auth())`). Each call
is its own instance, so you can pass config and keep per-instance state private
in the closure.

**Context middleware** (`extend`) — add typed, request-scoped fields:

```ts
import { extend } from '@ricokahler/wend/node';

const auth = () =>
  extend(async ({ req }) => ({
    user: await authenticate(req), // downstream: ctx.user, fully typed
  }));

route.with(auth()).match({ path: '/me', method: 'GET' }, handler(({ user, res }) => {
  res.json({ id: user.id });
}));
```

**Wrapper middleware** (`middleware`) — wrap execution (CORS, timing, logging):

```ts
import { middleware } from '@ricokahler/wend/fetch';

const cors = () =>
  middleware((next) => async (ctx) => {
    if (ctx.routing.method === 'OPTIONS') return new Response(null, { status: 204 });
    const res = await next(ctx);
    res.headers.set('access-control-allow-origin', '*');
    return res;
  });

route.with(cors())./* ...routes... */;
```

On `@ricokahler/wend/node`, set headers on `ctx.res` before/after `await next(ctx)` and
return nothing.

**Config + encapsulated state** are just the factory's arguments and closure —
each instance is private:

```ts
const rateLimit = ({ max }: { max: number }) => {
  const hits = new Map<string, number>(); // private to this instance
  return middleware((next) => async (ctx) => {
    const key = ctx.req.headers.get('x-forwarded-for') ?? 'anon';
    if ((hits.get(key) ?? 0) >= max) return new Response('Too many requests', { status: 429 });
    hits.set(key, (hits.get(key) ?? 0) + 1);
    return next(ctx);
  });
};

route.with(rateLimit({ max: 100 }));
```

**Depend on upstream context.** A middleware can read fields an earlier one
added; the read *is* the declaration, and the order is checked at compile time:

```ts
// auth() adds ctx.user; requireRole (extend) depends on it.
const requireRole = (role: string) =>
  extend(({ user }: { user: { role: string } }) => {
    if (user.role !== role) throw httpError(403, { error: 'forbidden' });
    return {};
  });

// A wrapper (middleware) that needs upstream context declares it via the type arg.
const auditLog = () =>
  middleware<{}, { user: { id: string } }>((next) => async (ctx) => {
    const res = await next(ctx);
    console.log(`${ctx.user.id} → ${res.status}`);
    return res;
  });

route.with(auth()).with(requireRole('admin')).with(auditLog());
// .with(requireRole('admin')) BEFORE auth() is a type error — ctx.user isn't there yet.
```

### Nested / reusable route trees

```ts
import { define, handler, notFound, type Router } from '@ricokahler/wend/node';

// Declare what context the sub-tree needs via the type argument.
const users = define<Router.Context<{ orgId: string }>>((route) =>
  route
    .match({ path: '/:userId', method: 'GET' }, handler(({ route, res }) => {
      res.json({ orgId: route.params.orgId, userId: route.params.userId });
    }))
    .serve(notFound('user route not found')),
);

// Mount it; parent params (orgId) flow in.
route.match({ path: '/orgs/:orgId/users' }, users).serve(notFound());
```

### Errors

```ts
import { httpError } from '@ricokahler/wend/node';

handler(({ route, res }) => {
  if (!route.params.id) throw httpError(400, { error: 'id required' }); // → 400 + body
  throw new Error('unexpected');                                         // → 500
});
```

Report 500s centrally:
```ts
createFetchHandler(routes, { onError: (err, ctx) => report(err, ctx.routing) });
```

### Mount in a host

```ts
// node:http
http.createServer(createNodeHandler(routes)).listen(3000);
// Express
expressApp.use(createNodeHandler(routes));
// Cloudflare Workers
export default { fetch: createFetchHandler(routes) };
// Deno
Deno.serve(createFetchHandler(routes));
// Bun
Bun.serve({ fetch: createFetchHandler(routes) });
```

## 5. Gotchas

- **Match the adapter's response contract.** A `@ricokahler/wend/fetch` handler that does not `return` a `Response` is a type error. A `@ricokahler/wend/node` handler responds via `ctx.res` (its return value is ignored).
- **Order matters.** Routes match in declaration order with prefix semantics. Put `'/status/history'` before `'/status'`. For exact matching, nest and end with `.serve(notFound())`.
- **`notFound()` is called, not just referenced** — `.serve(notFound())` (note the call). It returns a handler; to throw inline use `notFound()(ctx)` or just `throw new RouteNotFoundError(...)`.
- **Param types:** `:name` → `string`, `*name` → `string[]`, `{name}` → `string | undefined`.
- **`extend` vs `middleware`:** use `extend` to *add typed context*; use `middleware` to *wrap execution* (and, on fetch, transform the response).
- **Middleware ordering is type-checked.** A middleware that reads `ctx.user` won't mount before the one that adds it — `.with(...)` rejects it. Put providers before consumers.
- **Import from the adapter** (`@ricokahler/wend/node` / `@ricokahler/wend/fetch`) so `ctx.req`/`ctx.res` and the return type are correctly typed. Importing `handler`/`extend` from `@ricokahler/wend` directly loses the runtime-specific context typing.
- **Node 18+** is required (Fetch globals). The only dependency is `path-to-regexp`.
