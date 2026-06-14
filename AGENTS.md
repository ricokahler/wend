# AGENTS.md

`wend` is a typed, composable HTTP router: one immutable builder, compile-time
path-param inference, typed context accumulation, and two native runtime
adapters (Node `(req, res)` and Web Fetch `Request`/`Response`).

## Writing code that uses wend

**Read [`SKILL.md`](./SKILL.md).** It is the usage guide for agents — adapters,
the mental model, the full API, copy-paste recipes (routes, middleware, nested
trees, errors), and gotchas. Anything you write with `wend` should follow it.

One-line orientation: import from `@ricokahler/wend/node` (handlers mutate `res`) or
`@ricokahler/wend/fetch` (handlers return a `Response`); compose with
`route.with(mw).match(spec, def).serve(notFound())`.

## Repo layout

- `src/index.ts` — the runtime-agnostic core: the `Router` builder, type-level path-param inference, `Middleware`, `RouteNotFoundError` / `HttpError`, and the responder-driven `Router.errorBoundary`. **Must not import `node:http` or reference `Response`.**
- `src/node.ts` — `@ricokahler/wend/node`: `createNodeHandler` + helpers (`handler`, `define`, `extend`, `middleware`, `notFound`, `httpError`) pinned to `{ req, res }` and a `void` result.
- `src/fetch.ts` — `@ricokahler/wend/fetch`: `createFetchHandler` + the same helpers pinned to `{ req }` and a `Response` result.
- `test/{core,node,fetch}.test.ts` — vitest suites for the core and each adapter.
- `test/recipes.test.ts` — the README's recipes (validation, middleware factories, dependency chaining + a compile-time ordering check via `@ts-expect-error`), run so the documented patterns are guaranteed to compile and pass.
- `examples/` — runnable apps (node-express, cloudflare-worker, deno). Not published.

## Commands

```bash
npm test          # vitest run (core + node + fetch + README recipes)
npm run typecheck # tsc --noEmit over src + test
npm run build     # tsc -p tsconfig.build.json → dist/ (index, node, fetch)
```

## Conventions

- **ESM only**, `"type": "module"`. Relative imports use the `.js` extension (`Node16` resolution), e.g. `import { Router } from './index.js'`.
- **TypeScript strict.** Keep the type-level param inference in `src/index.ts` intact.
- **Keep the core runtime-agnostic.** New runtime support = a new thin adapter (`src/<runtime>.ts`) that supplies a base context + error responders to `Router.errorBoundary`; do not push runtime types into the core.
- **No new runtime dependencies** beyond `path-to-regexp` without strong reason.
- **Tests** cover the core through a trivial in-test adapter (string result) and each adapter through its real runtime shape (mock `req`/`res`; real `Request`/`Response`). Add cases alongside the matching suite. Any pattern shown in the README belongs in `test/recipes.test.ts` so the docs can't drift from what compiles.
