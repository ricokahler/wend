import { createFetchHandler, handler, httpError, notFound } from 'wend/fetch';

export default {
  fetch: createFetchHandler((route) =>
    route
      .match({ path: '/', method: 'GET' }, handler(() => Response.json({ ok: true })))
      .match({ path: '/users/:id', method: 'GET' }, handler(({ route }) => {
        if (route.params.id === '0') throw httpError(404, { error: 'no user 0' });
        return Response.json({ id: route.params.id });
      }))
      .serve(notFound()),
  ),
};
