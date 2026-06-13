# cloudflare-worker example

A Worker using `@ricokahler/wend/fetch`. Handlers return a `Response`.

```bash
npm install
npm run dev
# → curl localhost:8787/users/abc   →  {"id":"abc"}
```

`createFetchHandler(...)` returns a `(request) => Promise<Response>` function,
which is exactly the Worker `fetch` handler shape. The same definition runs on
Deno, Bun, and the Next.js App Router.
