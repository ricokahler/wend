import {
  match as createPathMatcher,
  type MatchFunction,
  type ParamData,
} from 'path-to-regexp';

type MaybePromise<T> = T | Promise<T>;

type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD';

type Simplify<T> = { [TKey in keyof T]: T[TKey] } & {};

type MergeObjects<TLeft extends object, TRight extends object> = Simplify<
  Omit<TLeft, keyof TRight> & TRight
>;

// ── Path param inference ──────────────────────────────────────

type ParamDelimiter =
  | '/'
  | '-'
  | '.'
  | '{'
  | '}'
  | '('
  | ')'
  | '['
  | ']'
  | '+'
  | '?'
  | '!'
  | ':'
  | '*'
  | '&'
  | '#'
  | '%'
  | '='
  | ' '
  | '\n'
  | '\t';

type RecordIfNamed<TKey extends string, TValue> = TKey extends ''
  ? {}
  : Record<TKey, TValue>;

type TakeQuotedName<
  TSource extends string,
  TAcc extends string = '',
> = TSource extends `${infer TChar}${infer TRest}`
  ? TChar extends '"'
    ? [TAcc, TRest]
    : TakeQuotedName<TRest, `${TAcc}${TChar}`>
  : [TAcc, ''];

type TakeParamName<
  TSource extends string,
  TAcc extends string = '',
> = TSource extends `${infer TChar}${infer TRest}`
  ? TChar extends ParamDelimiter
    ? [TAcc, `${TChar}${TRest}`]
    : TakeParamName<TRest, `${TAcc}${TChar}`>
  : [TAcc, ''];

type ParseNamedParam<
  TSource extends string,
  TAcc extends object,
> = TSource extends `"${infer TRest}`
  ? TakeQuotedName<TRest> extends [
      infer TName extends string,
      infer TRemaining extends string,
    ]
    ? ParseAllParams<
        TRemaining,
        MergeObjects<TAcc, RecordIfNamed<TName, string>>
      >
    : TAcc
  : TakeParamName<TSource> extends [
        infer TName extends string,
        infer TRemaining extends string,
      ]
    ? ParseAllParams<
        TRemaining,
        MergeObjects<TAcc, RecordIfNamed<TName, string>>
      >
    : TAcc;

type ParseWildcardParam<
  TSource extends string,
  TAcc extends object,
> = TSource extends `"${infer TRest}`
  ? TakeQuotedName<TRest> extends [
      infer TName extends string,
      infer TRemaining extends string,
    ]
    ? ParseAllParams<
        TRemaining,
        MergeObjects<TAcc, RecordIfNamed<TName, string[]>>
      >
    : TAcc
  : TakeParamName<TSource> extends [
        infer TName extends string,
        infer TRemaining extends string,
      ]
    ? ParseAllParams<
        TRemaining,
        MergeObjects<TAcc, RecordIfNamed<TName, string[]>>
      >
    : TAcc;

type ParseAllParams<
  TSource extends string,
  TAcc extends object = {},
> = TSource extends `${infer TChar}${infer TRest}`
  ? TChar extends ':'
    ? ParseNamedParam<TRest, TAcc>
    : TChar extends '*'
      ? ParseWildcardParam<TRest, TAcc>
      : ParseAllParams<TRest, TAcc>
  : TAcc;

type TakeGroup<
  TSource extends string,
  TAcc extends string = '',
> = TSource extends `${infer TChar}${infer TRest}`
  ? TChar extends '}'
    ? [TAcc, TRest]
    : TakeGroup<TRest, `${TAcc}${TChar}`>
  : [TAcc, ''];

type ParseOptionalParams<
  TSource extends string,
  TAcc extends object = {},
> = TSource extends `${infer TChar}${infer TRest}`
  ? TChar extends '{'
    ? TakeGroup<TRest> extends [
        infer TGroup extends string,
        infer TRemaining extends string,
      ]
      ? ParseOptionalParams<
          TRemaining,
          MergeObjects<TAcc, ParseAllParams<TGroup>>
        >
      : TAcc
    : ParseOptionalParams<TRest, TAcc>
  : TAcc;

// ── Route context merging ─────────────────────────────────────

type CurrentRouteParams<TContext extends object> = TContext extends {
  route: { params: infer TParams };
}
  ? TParams extends object
    ? TParams
    : {}
  : {};

type MergeRouteParams<
  TContext extends object,
  TParams extends object,
> = MergeObjects<CurrentRouteParams<TContext>, TParams>;

type WithMatchedRoute<
  TContext extends object,
  TParams extends object,
> = Simplify<
  Omit<TContext, 'route'> & Router.Context<MergeRouteParams<TContext, TParams>>
>;

// ── Errors ────────────────────────────────────────────────────

/** Thrown by `notFound()`; the error boundary turns it into a 404. */
export class RouteNotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'RouteNotFoundError';
  }
}

/**
 * Thrown to produce an explicit HTTP response with a custom status and body.
 * The error boundary renders `status` + `body` directly.
 *
 * ```ts
 * if (!user) throw new HttpError(403, { error: 'forbidden' });
 * ```
 */
export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body?: unknown) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body ?? { error: `HTTP ${status}` };
  }
}

/** Detects a thrown `HttpError` or any `{ status: number; body }` shape. */
function isHttpError(error: unknown): error is { status: number; body: unknown } {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number' &&
      'body' in error,
  );
}

// ── Router ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Router {
  /** Remaining request state that flows through nested route matches. */
  export interface RequestState {
    method: string;
    pathname: string;
  }

  /**
   * The context the core always provides. Runtime adapters extend this with
   * their own fields (e.g. `req`/`res` for Node, `req` for Fetch) when they
   * create the root router — the core itself stays runtime-agnostic.
   */
  export interface BaseContext {
    routing: RequestState;
  }

  /** A handler that receives the accumulated context and produces `TResult`. */
  export type Handler<TContext extends object = {}, TResult = void> = (
    ctx: BaseContext & TContext,
  ) => MaybePromise<TResult>;

  /**
   * A curried middleware step that can wrap execution and/or extend context.
   *
   * The returned handler narrows the required context from `TNeeds & TAdds`
   * back down to `TNeeds`, which lets `route.with(...)` accumulate context
   * types in declaration order.
   */
  export type Middleware<
    TAdds extends object = {},
    TNeeds extends object = {},
    TResult = void,
  > = (next: Handler<TNeeds & TAdds, TResult>) => Handler<TNeeds, TResult>;

  /** The branch match condition used by `route.match(...)`. */
  export interface RouteSpec {
    path: string;
    method?: HttpMethod;
  }

  /** Infers a useful subset of `path-to-regexp` params from a literal path string. */
  export type InferPathParams<TPath extends string> = Simplify<
    Omit<ParseAllParams<TPath>, keyof ParseOptionalParams<TPath>> &
      Partial<ParseOptionalParams<TPath>>
  >;

  /** The route-owned context slice injected by a successful branch match. */
  export type Context<TParams extends object = {}> = {
    route: {
      method?: HttpMethod;
      parent?: Context<any>['route'];
      params: TParams;
      pathname: string;
      pattern: string;
    };
  };

  /**
   * A reusable route definition that can be mounted at the root or inside
   * another route. The `route` parameter is precisely typed (so child params
   * and accumulated context flow correctly), while the returned handler is
   * widened to `Handler<any, TResult>` — middleware added with `.with(...)`
   * bakes its context into the handler, so the handler's *own* remaining
   * requirements are an implementation detail the mount point doesn't constrain.
   */
  export type Definition<TContext extends object = {}, TResult = void> = (
    route: Router<TContext, TResult>,
  ) => Handler<any, TResult>;

  /** The compiled runtime form stored by a `Router` instance. */
  export interface Route<TResult = void> {
    handler: Handler<any, TResult>;
    matcher: MatchFunction<ParamData>;
    method?: HttpMethod;
    pattern: string;
  }

  /** The immutable state carried by a `Router` instance. */
  export interface Options<TResult = void> {
    middleware?: Router.Middleware<any, any, TResult>;
    routes?: Router.Route<TResult>[];
  }

  /**
   * Tells `errorBoundary()` how to turn a thrown value into a response in a
   * given runtime. The branching (404 / `{ status, body }` / 500 + reporting)
   * lives in the core; an adapter only supplies how to render each case.
   */
  export interface ErrorResponders<
    TContext extends BaseContext = BaseContext,
    TResult = void,
  > {
    /** Render a 404 for an uncaught `RouteNotFoundError`. */
    onNotFound: (ctx: TContext, message: string) => TResult;
    /** Render a thrown `HttpError` / `{ status, body }`. */
    onHttpError: (ctx: TContext, status: number, body: unknown) => TResult;
    /** Render a 500 for any other thrown value. */
    onServerError: (ctx: TContext, message: string) => TResult;
    /**
     * Optional guard: if a response has already been committed, rethrow rather
     * than try to respond again (Node's mutable `res`). Omit where responses
     * are values that are never half-sent (Fetch).
     */
    hasResponded?: (ctx: TContext) => boolean;
    /**
     * Invoked for unexpected errors (not a `RouteNotFoundError` or an
     * `{ status, body }`) right before the 500 is rendered — the place to
     * report a genuine server failure. Must not throw.
     */
    onError?: (error: unknown, ctx: TContext) => void;
  }
}

/**
 * Immutable, runtime-agnostic router builder.
 *
 * One flowing context object serves both middleware and routing. Each call to
 * `with(...)` or `match(...)` returns a new `Router` whose types reflect the
 * context or child routes that were added — no mutation, no ordering bugs.
 *
 * The core knows nothing about any runtime. A handler returns a `TResult`; a
 * runtime adapter (`@ricokahler/wend/node`, `@ricokahler/wend/fetch`) decides
 * what `TResult` is, seeds the base context, and renders results + errors. See
 * those entry points for ready-made, fully-typed helpers.
 */
export class Router<TContext extends object = {}, TResult = void> {
  readonly middleware: Router.Middleware<any, any, TResult>;
  readonly routes: Router.Route<TResult>[];

  constructor({
    middleware = (next) => next,
    routes = [],
  }: Router.Options<TResult> = {}) {
    this.middleware = middleware;
    this.routes = routes;
  }

  /** Names a reusable route definition without changing its runtime behavior. */
  static define<TContext extends object = {}, TResult = void>(
    definition: Router.Definition<TContext, TResult>,
  ): Router.Definition<TContext, TResult> {
    return definition;
  }

  /**
   * Sugar for the common terminal case — a definition that serves one handler.
   *
   * ```ts
   * Router.handler(({ res }) => res.end('ok'))
   * // ≡ (route) => route.serve(({ res }) => res.end('ok'))
   * ```
   */
  static handler<TContext extends object = {}, TResult = void>(
    handler: Router.Handler<TContext, TResult>,
  ): Router.Definition<TContext, TResult> {
    return (route) => route.serve(handler);
  }

  /**
   * Builds a middleware that shallowly extends the current context with the
   * fields it returns.
   *
   * ```ts
   * const auth = Router.extend(async ({ req }) => ({
   *   user: await authenticate(req),
   * }));
   * ```
   */
  static extend<
    TAdds extends object,
    TNeeds extends object = {},
    TResult = void,
  >(
    buildContext: (ctx: Router.BaseContext & TNeeds) => MaybePromise<TAdds>,
  ): Router.Middleware<TAdds, TNeeds, TResult> {
    return (next) => async (ctx) => {
      const adds = await buildContext(ctx);
      return next({ ...ctx, ...adds });
    };
  }

  /** Identity helper for wrapper-style middleware definitions. */
  static middleware<
    TAdds extends object = {},
    TNeeds extends object = {},
    TResult = void,
  >(
    middleware: Router.Middleware<TAdds, TNeeds, TResult>,
  ): Router.Middleware<TAdds, TNeeds, TResult> {
    return middleware;
  }

  /**
   * Builds the error middleware that adapters install around a root definition.
   *
   * Translates `notFound()` misses into 404, thrown `HttpError`/`{ status,
   * body }` into that response, and everything else into 500 — rendered via the
   * supplied `responders` so the core stays runtime-agnostic.
   */
  static errorBoundary<TContext extends object = {}, TResult = void>(
    responders: Router.ErrorResponders<Router.BaseContext & TContext, TResult>,
  ): Router.Middleware<{}, TContext, TResult> {
    return (next) => async (ctx) => {
      try {
        return await next(ctx);
      } catch (error) {
        if (responders.hasResponded?.(ctx)) throw error;

        if (error instanceof RouteNotFoundError) {
          return responders.onNotFound(ctx, error.message);
        }
        if (isHttpError(error)) {
          return responders.onHttpError(ctx, error.status, error.body);
        }

        responders.onError?.(error, ctx);
        return responders.onServerError(
          ctx,
          error instanceof Error ? error.message : 'Internal server error',
        );
      }
    };
  }

  /**
   * Returns a handler that throws the not-found sentinel. Use as the terminal
   * fallback in `.serve(...)`.
   *
   * ```ts
   * route.serve(Router.notFound('User route not found'));
   * ```
   */
  static notFound(message = 'Not found'): Router.Handler<any, any> {
    return () => {
      throw new RouteNotFoundError(message);
    };
  }

  /** Builds an `HttpError` to throw for an explicit status + body. */
  static httpError(status: number, body?: unknown): HttpError {
    return new HttpError(status, body);
  }

  /**
   * Adds a middleware step and returns a new router whose context includes any
   * fields the middleware adds.
   */
  with<TAdds extends object = {}, TNeeds extends object = {}>(
    middleware: [TContext] extends [TNeeds]
      ? Router.Middleware<TAdds, TNeeds, TResult>
      : never,
  ): Router<TContext & TAdds, TResult> {
    const step = middleware as Router.Middleware<TAdds, TNeeds, TResult>;
    return new Router<TContext & TAdds, TResult>({
      middleware: (next) => this.middleware(step(next as never) as never),
      routes: this.routes,
    });
  }

  /**
   * Registers a child route branch and returns a new router. Params inferred
   * from `spec.path` are merged into `ctx.route.params` for the child.
   */
  match<TPath extends string>(
    spec: Router.RouteSpec & { path: TPath },
    definition: Router.Definition<
      WithMatchedRoute<TContext, Router.InferPathParams<TPath>>,
      TResult
    >,
  ): Router<TContext, TResult>;
  match<TParams extends ParamData, TPath extends string = string>(
    spec: Router.RouteSpec & { path: TPath },
    definition: Router.Definition<WithMatchedRoute<TContext, TParams>, TResult>,
  ): Router<TContext, TResult>;
  match(
    { path: pattern, method }: Router.RouteSpec,
    definition: Router.Definition<any, TResult>,
  ): Router<TContext, TResult> {
    const handler = definition(new Router());
    const matcher = createPathMatcher<ParamData>(pattern, { end: false });
    const route: Router.Route<TResult> = { handler, matcher, method, pattern };

    return new Router<TContext, TResult>({
      middleware: this.middleware,
      routes: [...this.routes, route],
    });
  }

  /**
   * Finalizes the current router scope into a handler. Routes are tried in
   * declaration order; the first match wins; if none match, `fallback` runs.
   *
   * The result is typed `Handler<any, TResult>`: middleware added with
   * `.with(...)` is baked in, so the composed handler's remaining context
   * requirements are an implementation detail. Widening here keeps `Router`
   * contravariant in `TContext`, so a route enriched beyond a sub-router's
   * declared context still composes.
   */
  serve(
    fallback: Router.Handler<TContext, TResult>,
  ): Router.Handler<any, TResult> {
    const next: Router.Handler<TContext, TResult> = async (ctx) => {
      const parent = (ctx as Partial<Router.Context<any>>).route;

      for (const route of this.routes) {
        if (route.method && route.method.toUpperCase() !== ctx.routing.method) {
          continue;
        }

        const matched = route.matcher(ctx.routing.pathname);
        if (!matched) continue;

        const nextRoute: Router.Context<any>['route'] = {
          method: route.method,
          parent,
          params: { ...(parent?.params ?? {}), ...matched.params },
          pathname: matched.path,
          pattern: route.pattern,
        };

        return route.handler({
          ...ctx,
          route: nextRoute,
          routing: {
            method: ctx.routing.method,
            pathname: ctx.routing.pathname.slice(matched.path.length) || '/',
          },
        });
      }

      return fallback(ctx);
    };

    return this.middleware(next);
  }
}
