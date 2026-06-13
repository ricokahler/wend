import type { IncomingMessage, ServerResponse } from 'node:http';
import { Router, type HttpError } from './index.js';

type MaybePromise<T> = T | Promise<T>;

/**
 * The base context for Node handlers. You respond by mutating `res`
 * (`res.writeHead`/`res.end`, or Express's `res.json`/`res.status`); the
 * handler itself returns `void`.
 */
export interface NodeContext {
  req: IncomingMessage;
  res: ServerResponse;
}

export interface NodeHandlerOptions {
  /** Reported for unexpected errors right before the 500 response. */
  onError?: (error: unknown, ctx: Router.BaseContext & NodeContext) => void;
  /** Override how the method + pathname are read from the request. */
  getRouting?: (req: IncomingMessage) => Router.RequestState;
}

/** Writes JSON, preferring Express's `res.json` when present. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const express = res as ServerResponse & {
    status?: (code: number) => { json: (data: unknown) => void };
    json?: (data: unknown) => void;
  };
  if (typeof express.status === 'function' && typeof express.json === 'function') {
    express.status(status).json(body);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Reads `originalUrl` (set by Express on sub-app mounts) then `url`. */
function defaultGetRouting(req: IncomingMessage): Router.RequestState {
  const raw =
    (req as IncomingMessage & { originalUrl?: string }).originalUrl ??
    req.url ??
    '/';
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    pathname: new URL(raw, 'http://localhost').pathname,
  };
}

/**
 * Builds an `(req, res) => Promise<void>` handler for Node-style servers
 * (`node:http`, Express, Next.js pages API, Fastify raw, Google Cloud
 * Functions). Installs an error boundary that renders `notFound()` as 404,
 * thrown `HttpError`/`{ status, body }` as that response, and anything else as
 * 500 (after `onError`).
 *
 * ```ts
 * const app = createNodeHandler((route) =>
 *   route
 *     .match({ path: '/users/:id', method: 'GET' }, handler(({ route, res }) => {
 *       res.writeHead(200, { 'content-type': 'application/json' });
 *       res.end(JSON.stringify({ id: route.params.id }));
 *     }))
 *     .serve(notFound()),
 * );
 *
 * http.createServer(app).listen(3000);
 * ```
 */
export function createNodeHandler(
  definition: Router.Definition<NodeContext, void>,
  options: NodeHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const boundary = Router.errorBoundary<NodeContext, void>({
    hasResponded: ({ res }) => res.headersSent || res.writableEnded,
    onNotFound: ({ res }, message) => sendJson(res, 404, { error: message }),
    onHttpError: ({ res }, status, body) => sendJson(res, status, body),
    onServerError: ({ res }, message) => sendJson(res, 500, { error: message }),
    onError: options.onError,
  });
  const root = boundary(definition(new Router<NodeContext, void>()));
  const getRouting = options.getRouting ?? defaultGetRouting;

  return async (req, res) => {
    await root({ req, res, routing: getRouting(req) });
  };
}

// ── Fully-typed helpers (base context + `void` result pre-bound) ──

/**
 * A terminal handler — `ctx.req`/`ctx.res` and any added context are typed.
 * Respond by mutating `res`; the return value is ignored (so chainable calls
 * like `res.json(x)` and `async` handlers both work).
 */
export function handler<TContext extends object = {}>(
  fn: (ctx: Router.BaseContext & NodeContext & TContext) => void,
): Router.Definition<NodeContext & TContext, void> {
  return Router.handler(fn);
}

/** Names a reusable sub-route tree; `req`/`res` are typed inside it. */
export function define<TContext extends object = {}>(
  definition: Router.Definition<NodeContext & TContext, void>,
): Router.Definition<NodeContext & TContext, void> {
  return Router.define(definition);
}

/** Context middleware: returns fields merged into downstream context. */
export function extend<TAdds extends object, TContext extends object = {}>(
  buildContext: (
    ctx: Router.BaseContext & NodeContext & TContext,
  ) => MaybePromise<TAdds>,
): Router.Middleware<TAdds, NodeContext & TContext, void> {
  return Router.extend<TAdds, NodeContext & TContext, void>(buildContext);
}

/** Wrapper middleware: wrap execution (CORS, timing, logging). */
export function middleware<
  TAdds extends object = {},
  TContext extends object = {},
>(
  middleware: Router.Middleware<TAdds, NodeContext & TContext, void>,
): Router.Middleware<TAdds, NodeContext & TContext, void> {
  return middleware;
}

/** Terminal fallback that produces a 404 with `message`. */
export function notFound(message?: string): Router.Handler<NodeContext, void> {
  return Router.notFound(message);
}

/** Throw to produce an explicit status + body. */
export function httpError(status: number, body?: unknown): HttpError {
  return Router.httpError(status, body);
}

export { Router, RouteNotFoundError, HttpError } from './index.js';
