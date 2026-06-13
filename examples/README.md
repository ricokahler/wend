# Examples

Each example is a minimal, runnable app using the same route definitions across
runtimes — only the adapter and how a handler responds differ.

- [`node-express`](./node-express) — Express, using `wend/node` (mutate `res`).
- [`cloudflare-worker`](./cloudflare-worker) — Cloudflare Workers, using `wend/fetch` (return `Response`).
- [`deno`](./deno) — `Deno.serve`, using `wend/fetch`.

Each directory has its own README with the run command.
