import { createFetchHandler, handler, notFound } from 'npm:@ricokahler/wend/fetch';

const app = createFetchHandler((route) =>
  route
    .match({ path: '/', method: 'GET' }, handler(() => Response.json({ ok: true })))
    .match({ path: '/users/:id', method: 'GET' }, handler(({ route }) =>
      Response.json({ id: route.params.id }),
    ))
    .serve(notFound()),
);

Deno.serve(app);
