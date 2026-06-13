# node-express example

Express mounting a `@ricokahler/wend/node` handler. Handlers respond by mutating `res`.

```bash
npm install
npm start
# → curl localhost:3000/users/abc   →  {"id":"abc","ms":0}
# → curl localhost:3000/nope        →  404 {"error":"Not found"}
```

`createNodeHandler(...)` returns an `(req, res)` function, so it mounts with
`app.use(...)`. The same definition runs on raw `node:http`
(`http.createServer(app)`), Next.js pages API, and Fastify (raw).
