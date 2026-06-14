import { Router, type HttpError } from './index.js';

type MaybePromise<T> = T | Promise<T>;

/**
 * The base context for Fetch handlers. You respond by **returning** a Web
 * `Response`; `ctx.req` is the Web `Request`.
 */
export interface FetchContext {
  req: Request;
}

/** The full context every Fetch handler receives: routing plus `req`. */
export type FetchBaseContext = Router.BaseContext & FetchContext;

/** The handler shape `createFetchHandler` returns. */
export type FetchHandler = (request: Request) => Promise<Response>;

export interface FetchHandlerOptions {
  /** Reported for unexpected errors right before the 500 response. */
  onError?: (error: unknown, ctx: Router.BaseContext & FetchContext) => void;
  /** Override how the method + pathname are read from the request. */
  getRouting?: (request: Request) => Router.RequestState;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function defaultGetRouting(request: Request): Router.RequestState {
  return {
    method: request.method.toUpperCase(),
    pathname: new URL(request.url).pathname,
  };
}

/**
 * Builds a `(request: Request) => Promise<Response>` handler for Web-standard
 * runtimes (Cloudflare Workers, Deno, Bun, Next.js App Router). Installs an
 * error boundary that renders `notFound()` as 404, thrown `HttpError`/`{
 * status, body }` as that response, and anything else as 500 (after `onError`).
 *
 * ```ts
 * const app = createFetchHandler((route) =>
 *   route
 *     .match({ path: '/users/:id', method: 'GET' }, handler(({ route }) =>
 *       Response.json({ id: route.params.id }),
 *     ))
 *     .serve(notFound()),
 * );
 *
 * export default { fetch: app }; // Cloudflare Workers
 * ```
 */
export function createFetchHandler(
  definition: Router.Definition<FetchContext, Response>,
  options: FetchHandlerOptions = {},
): FetchHandler {
  const boundary = Router.errorBoundary<FetchContext, Response>({
    onNotFound: (_ctx, message) => jsonResponse({ error: message }, 404),
    onHttpError: (_ctx, status, body) => jsonResponse(body, status),
    onServerError: (_ctx, message) => jsonResponse({ error: message }, 500),
    onError: options.onError,
  });
  const root = boundary(definition(new Router<FetchContext, Response>()));
  const getRouting = options.getRouting ?? defaultGetRouting;

  return async (request) => root({ req: request, routing: getRouting(request) });
}

// ── Fully-typed helpers (base context + `Response` result pre-bound) ──

/** A terminal handler — it must return a `Response`. */
export function handler<TContext extends object = {}>(
  fn: Router.Handler<FetchContext & TContext, Response>,
): Router.Definition<FetchContext & TContext, Response> {
  return Router.handler(fn);
}

/** Names a reusable sub-route tree; `req` + params are typed inside it. */
export function define<TContext extends object = {}>(
  definition: Router.Definition<FetchContext & TContext, Response>,
): Router.Definition<FetchContext & TContext, Response> {
  return Router.define(definition);
}

/** Context middleware: returns fields merged into downstream context. */
export function extend<TAdds extends object, TContext extends object = {}>(
  buildContext: (
    ctx: Router.BaseContext & FetchContext & TContext,
  ) => MaybePromise<TAdds>,
): Router.Middleware<TAdds, FetchContext & TContext, Response> {
  return Router.extend<TAdds, FetchContext & TContext, Response>(buildContext);
}

/** Wrapper middleware: wrap execution and/or transform the returned `Response`. */
export function middleware<
  TAdds extends object = {},
  TContext extends object = {},
>(
  middleware: Router.Middleware<TAdds, FetchContext & TContext, Response>,
): Router.Middleware<TAdds, FetchContext & TContext, Response> {
  return middleware;
}

/** Terminal fallback that produces a 404 with `message`. */
export function notFound(message?: string): Router.Handler<FetchContext, Response> {
  return Router.notFound(message);
}

/** Throw to produce an explicit status + body. */
export function httpError(status: number, body?: unknown): HttpError {
  return Router.httpError(status, body);
}

export { Router, RouteNotFoundError, HttpError } from './index.js';
