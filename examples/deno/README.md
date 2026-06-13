# deno example

`Deno.serve` using `@ricokahler/wend/fetch` via the `npm:` specifier.

```bash
deno run --allow-net main.ts
# → curl localhost:8000/users/abc   →  {"id":"abc"}
```

`createFetchHandler(...)` returns a `(request) => Promise<Response>` function,
which `Deno.serve` accepts directly.
