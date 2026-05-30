# Code Context: HTTP Router Layer Context Propagation

## Files Retrieved

### Primary (opencode source)
1. `packages/opencode/src/server/routes/instance/httpapi/server.ts` (lines 1-222) — Route construction, `createRoutes()`, `toWebHandler` call, and `HttpApiApp.context` (empty context)
2. `packages/opencode/src/server/server.ts` (lines 1-165) — Listener construction, `listenerLayer()`, `Layer.buildWithMemoMap` call, and `HttpApiApp.context` passed as override
3. `packages/opencode/src/server/routes/instance/httpapi/lifecycle.ts` (lines 1-58) — `disposeMiddleware` and `markInstanceForDisposal`/`markInstanceForReload`
4. `packages/opencode/src/effect/bridge.ts` (lines 1-83) — `EffectBridge.make()` and how it captures the Effect context
5. `packages/opencode/src/project/instance-store.ts` (lines 1-80) — `InstanceStore.Service` definition and its Layer dependencies (`Project.Service | InstanceBootstrap.Service`)
6. `packages/opencode/src/project/instance-layer.ts` (lines 1-11) — `InstanceLayer.layer` wraps `InstanceStore.defaultLayer`
7. `packages/opencode/src/server/routes/instance/httpapi/websocket-tracker.ts` (lines 1-70) — Uses `Effect.serviceOption(Service)` pattern
8. `packages/opencode/src/event-v2-bridge.ts` (lines 1-60) — Uses `Effect.serviceOption(InstanceStore.Service)` pattern
9. `packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts` (lines 1-100) — Only handler that uses `DatabaseAdapter.Service`

### Framework source (effect@4.0.0-beta.48)
10. `node_modules/.bun/effect@4.0.0-beta.48/node_modules/effect/src/unstable/http/HttpRouter.ts` (lines 1-780) — `toWebHandler`, `serve`, `toHttpEffect`, `asHttpEffect`, and middleware composition
11. `node_modules/.bun/effect@4.0.0-beta.48/node_modules/effect/src/unstable/http/HttpEffect.ts` (lines 1-280) — `toWebHandlerLayerWith`, `toWebHandlerWith`, `toHandled` — the core request-dispatch machinery
12. `node_modules/.bun/effect@4.0.0-beta.48/node_modules/effect/src/unstable/http/HttpServer.ts` (lines 1-190) — `HttpServer.serve` creates the layer that calls `server.serve(effect, middleware)`
13. `node_modules/.bun/effect@4.0.0-beta.48/node_modules/effect/src/Layer.ts` (lines 570-580) — `buildWithMemoMap` calls `self.build(memoMap, scope)`; missing-service failures happen here at build time

## Key Code

### The two context-propagation paths

**Path A — `toWebHandler` (used for `ServerApp.fetch` in `packages/opencode/src/server/server.ts:169-170`):**

```ts
// server.ts line 87-92
export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

// server.ts line 169-170
const handler = HttpApiApp.webHandler().handler
const app: ServerApp = {
  fetch: (request: Request) => handler(request, HttpApiApp.context),
}
```

`HttpApiApp.context` is `Context.makeUnsafe<unknown>(new Map())` — **an empty context** (line 98 of `server.ts` in the routes file).

**Path B — `HttpRouter.serve` (used for the listener in `packages/opencode/src/server/server.ts:107-119`):**

```ts
// server.ts (listener) lines 107-119
function listenerLayer(opts: ListenOptions, port: number) {
  return HttpRouter.serve(HttpApiApp.createRoutes(opts), {
    middleware: disposeMiddleware,
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provideMerge(WebSocketTracker.layer),
    Layer.provideMerge(serverLayer({ port, hostname: opts.hostname })),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  )
}

// server.ts line 127-129 (inside startListener())
return Layer.buildWithMemoMap(listenerLayer(opts, port), Layer.makeMemoMapUnsafe(), scope).pipe(
  Effect.provide(HttpApiApp.context),  // empty context here too
```

### How `toWebHandlerLayerWith` builds the context

From `HttpEffect.ts` (framework):

```ts
// Compiles the layer ONCE into a Context, then reuses it for every request
handlerPromise ??= Effect.runPromise(Effect.gen(function*() {
  const context = yield* (options.memoMap
    ? Layer.buildWithMemoMap(layer, options.memoMap, scope)
    : Layer.buildWithScope(layer, scope))
  return handlerCache = toWebHandlerWith<Provided, R>(context)(
    yield* options.toHandler(context),  // extracts router.asHttpEffect()
    options.middleware                   // disposeMiddleware applied here
  ) as any
}))
```

### How each request gets its context

From `HttpEffect.ts`, `toWebHandlerWith`:

```ts
return (request: Request, reqContext?: Context.Context<never> | undefined): Promise<globalThis.Response> =>
  new Promise((resolve) => {
    const contextMap = new Map<string, any>(context.mapUnsafe)  // base = built layer
    if (Context.isContext(reqContext)) {
      for (const [key, value] of reqContext.mapUnsafe) {       // OVERRIDE: reqContext.set() overwrites base
        contextMap.set(key, value)
      }
    }
    const httpServerRequest = Request.fromWeb(request)
    contextMap.set(HttpServerRequest.key, httpServerRequest)   // adds request to context
    const fiber = Effect.runForkWith(Context.makeUnsafe(contextMap))(httpApp as any)
```

### `disposeMiddleware` — what services it accesses

```ts
// lifecycle.ts lines 19-20, 32-53
const mark = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    return { ctx, store: yield* InstanceStore.Service, bridge: yield* EffectBridge.make() }
  })

export const disposeMiddleware: HttpMiddleware.HttpMiddleware = (effect) =>
  Effect.gen(function* () {
    const response = yield* effect
    const request = yield* HttpServerRequest.HttpServerRequest  // always in request context
    const marked = disposeAfterResponse.get(request.source)
    if (!marked) return response
    disposeAfterResponse.delete(request.source)
    yield* Effect.uninterruptible(marked.bridge.run(marked.store.dispose(marked.ctx))).pipe(
      Effect.catchCause((cause) => Effect.sync(() => log.warn("instance disposal failed", { cause }))),
    )
    return response
  })
```

`mark()` is called **during** request handling (via `markInstanceForDisposal` or `markInstanceForReload`), so `InstanceStore.Service` is available at that point. The resulting `marked.store` and `marked.bridge` are **closure-captured**, not Effect-context-looked-up. `marked.bridge.run(...)` replays the disposed effect with the **captured context** from `mark()` time, so all services are available.

### `EffectBridge.make()` context capture

```ts
// bridge.ts lines 60-62
export function make(): Effect.Effect<Shape> {
  return Effect.gen(function* () {
    const ctx = yield* Effect.context()       // <-- captures the entire Effect context
    const captured = captureSync()
    const instance = (yield* InstanceRef) ?? captured.instance
    const workspace = (yield* WorkspaceRef) ?? captured.workspace
    const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      attachWith(effect.pipe(Effect.provide(ctx)) as Effect.Effect<A, E, never>, { instance, workspace })
```

`ctx` captures ALL services available at `mark()` time, so the disposal effect `marked.store.dispose(marked.ctx)` runs with full context.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Layer.buildWithMemoMap                          │
│  (builds all layers into one Context at startup — either via        │
│   toWebHandlerLayerWith or via startListener)                       │
│  FAILS HERE if any service is missing (build-time error)            │
│                                                                     │
│     ┌──────────────────────────────────────────────────────────┐    │
│     │  Built Context (all services: DatabaseAdapter,            │    │
│     │  InstanceStore, Project, Auth, etc.)                      │    │
│     └──────────────────────┬───────────────────────────────────┘    │
│                            │                                        │
│              ┌─────────────▼──────────────────┐                     │
│              │  toWebHandlerWith(context,     │                     │
│              │    router.asHttpEffect(),       │                     │
│              │    disposeMiddleware)           │                     │
│              └─────────────┬──────────────────┘                     │
│                            │                                        │
│    ┌───────────────────────▼──────────────────────┐                │
│    │  Per-request fiber context:                  │                │
│    │    base = built context mapUnsafe            │                │
│    │    + reqContext.entries (overrides)          │                │
│    │    + HttpServerRequest                       │                │
│    │                                              │                │
│    │  handler pipeline:                           │                │
│    │    disposeMiddleware(router handler)         │                │
│    │      ├─ runs inner effect (request handler)  │                │
│    │      │  may call markInstanceForDisposal()   │                │
│    │      │  which captures InstanceStore.Service │                │
│    │      │  + Effect context into closure        │                │
│    │      ├─ gets response                        │                │
│    │      └─ runs marked.store.dispose() via      │                │
│    │         bridge with captured context          │                │
│    └──────────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────────────┘
```

## Start Here

Start with `packages/opencode/src/server/routes/instance/httpapi/server.ts` — it defines `createRoutes()` (the layer composition), the `HttpApiApp.context` (empty override), and the `toWebHandler` call. Then trace into `packages/opencode/src/server/server.ts` for the `serve` path and the `HttpApiApp.context` usage at line 129.

## Answers to Questions

### Q1: Does the built layer context propagate to request handlers, or can the optional `context` override strip services?

**The built layer context IS the base context.** The optional `context` parameter CAN override services in the base context (via `Map.set()` which overwrites same-key entries). However, `HttpApiApp.context` is `Context.makeUnsafe<unknown>(new Map())` — **an empty context**. The loop `for (const [key, value] of reqContext.mapUnsafe)` on an empty Map does nothing, so **no services are overridden or stripped**.

If a non-empty context were passed (e.g., `handler(request, someNonEmptyContext)`), services with matching keys would be replaced. This is by design, but the current usage is safe.

### Q2: Does the context from `Layer.buildWithMemoMap(listenerLayer(...))` properly flow through `HttpRouter.serve` → `HttpServer.serve` to request handlers?

**Yes, correctly.** The chain is:

1. `HttpRouter.serve(appLayer, { middleware })` merges appLayer into the router, extracts `router.asHttpEffect()`, and wraps it with `HttpServer.serve(handler, middleware)`. This produces a `Layer` requiring `HttpServer`.
2. `Layer.buildWithMemoMap` resolves this layer (plus WebSocketTracker, server config, etc.) into a `Context` with all services.
3. The `NodeHttpServer` implementation calls `HttpEffect.toHandled(handler, middleware)` for each request, which creates a scoped fiber with the built context + per-request `HttpServerRequest`.
4. The `disposeMiddleware` wraps the handler and runs within the same fiber context.

The `HttpApiApp.context` passed to `Effect.provide()` at `server.ts:129` is also empty (same `Context.makeUnsafe`), so no services are stripped from the built context.

### Q3: Does `disposeMiddleware` access any services that might not be available?

**No.** `disposeMiddleware` accesses:
- `HttpServerRequest.HttpServerRequest` — always provided in the request fiber context
- `disposeAfterResponse` (WeakMap) — a module-level variable, not an Effect service
- `marked.store` — captured at `mark()` time as an `InstanceStore.Interface` object (not a service lookup)
- `marked.bridge` — captures the entire Effect context at `mark()` time via `Effect.context()`, so `marked.bridge.run(...)` replays the disposal effect with all needed services

The only Effect-service access in `mark()` is `yield* InstanceStore.Service`, which is called **during the request handler** (when `InstanceStore.Service` IS in the context). After capture, disposal happens via closure, not context lookup.

### Q4: Are there `Effect.serviceOption` patterns that could silently fail if `DatabaseAdapter` is missing?

**No `serviceOption` usage for `DatabaseAdapter` exists.** The only `serviceOption` patterns found:

| File | Line | Service | Behavior |
|------|------|---------|----------|
| `websocket-tracker.ts` | 49 | `WebSocketTracker.Service` | Returns `none` if not registered; websocket close tracking is silently skipped when running outside a server process |
| `event-v2-bridge.ts` | 51 | `InstanceStore.Service` | Returns `undefined` if store is missing; falls back to publishing globally without instance context |

`DatabaseAdapter.Service` is used directly (`yield* DatabaseAdapter.Service`) only in `handlers/sync.ts:82`. If it were missing, the error would manifest in one of two places:

- **Build time:** `Layer.buildWithMemoMap` in `toWebHandlerLayerWith` (line ~267 of `HttpEffect.ts`). If any layer fails to provide a required service, the Effect fails with a `NoSuchElementException` at **build time**, not at request time. This is the normal path.
- **Request time:** If somehow a service were absent from the fiber context despite layer building succeeding, `Context.get` / `yield*` would throw at request time. But this cannot happen with the current code because `DatabaseAdapter.defaultLayer` is provided at two levels in `createRoutes()`:
  1. Line 136 (`instanceApiRoutes` level)
  2. Line 198 (`createRoutes` merge level)

Both the `toWebHandler` and `serve` paths build the same `createRoutes()` layer, so `DatabaseAdapter.Service` is available in both.

## Verdict

**Context propagation is correct.** The empty `HttpApiApp.context` override does **not** strip services. The `disposeMiddleware` uses closure-captured references, bypassing potential context issues. The `DatabaseAdapter` is properly provided at the merge level of `createRoutes()`, ensuring it's available in all request handlers. No silent `serviceOption` fallback exists for `DatabaseAdapter`.
