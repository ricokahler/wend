import express from 'express';
import { createNodeHandler, extend, handler, httpError, notFound } from 'wend/node';

// Context middleware: adds a typed field every downstream handler can read.
const requestStart = extend(() => ({ startedAt: Date.now() }));

const app = createNodeHandler((route) =>
  route
    .with(requestStart)
    .match({ path: '/', method: 'GET' }, handler(({ res }) => {
      res.json({ ok: true });
    }))
    .match({ path: '/users/:id', method: 'GET' }, handler(({ route, startedAt, res }) => {
      if (route.params.id === '0') throw httpError(404, { error: 'no user 0' });
      res.json({ id: route.params.id, ms: Date.now() - startedAt });
    }))
    .serve(notFound()),
);

const server = express();
server.use(app);
server.listen(3000, () => {
  console.log('listening on http://localhost:3000');
  console.log('try: curl localhost:3000/users/abc');
});
