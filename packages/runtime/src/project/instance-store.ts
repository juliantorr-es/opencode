import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@tribunus/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { Context, Deferred, Duration, Effect, Exit, Layer, Option } from "effect"
import { InstanceTrace } from "./instance-trace"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import { Service as InstanceHealthStoreService } from "./instance-health"
import * as Project from "./project"
import { InstanceRuntimeTag } from "./instance-runtime-contract"
import { InstanceEnvironment } from "./instance-environment"

import { TraceSpans, endSpan } from "@/observability/traces"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)


interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const health = yield* InstanceHealthStoreService
    const cache = new Map<string, Entry>()


    // Provide InstanceEnvironment before fork so forked svc.init() fibers
    // can resolve DatabaseAdapter, EventStore, DuckDBConfig, etc.
    const forkInstance = <A, E>(
      label: string,
      effect: Effect.Effect<A, E, never>,
    ) =>
      Effect.gen(function* () {
        const runtime = yield* InstanceRuntimeTag
        return yield* runtime.fork(label, effect)
      })
    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        yield* health.set(ctx.directory, { status: "booting", updatedAt: Date.now() })
        const result = yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        const span = TraceSpans.instanceBoot(ctx.directory)
        let _spanError: unknown
        try {
          yield* health.set(ctx.directory, {
            status: result.status,
            failedServices: result.failedServices,
            updatedAt: Date.now(),
          })
          yield* Effect.sync(() =>
            GlobalBus.emit("event", {
              directory: ctx.directory,
              project: ctx.project.id,
              workspace: WorkspaceContext.workspaceID,
              payload: result.status === "ready"
                ? { type: "instance.loaded", properties: { directory: ctx.directory } }
                : result.status === "degraded"
                  ? { type: "instance.degraded", properties: { directory: ctx.directory, failedServices: result.failedServices } }
                  : { type: "instance.failed", properties: { directory: ctx.directory, error: "All services failed to initialize" } },
            }),
          )
        } catch (e) {
          _spanError = e
        }
        endSpan(span, _spanError)
        if (_spanError !== undefined) throw _spanError
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const trace = yield* Effect.serviceOption(InstanceTrace.Service)
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) {
          if (Option.isSome(trace)) yield* trace.value.writeFailure("instance.failed", "boot_failed", "Instance boot failed", exit.cause)
          yield* removeEntry(directory, entry)
          yield* health.remove(directory)
        } else {
          if (Option.isSome(trace)) yield* trace.value.writePhase("instance.ready", "completed", directory)
        }
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      const trace = yield* Effect.serviceOption(InstanceTrace.Service)
      if (Option.isSome(trace)) yield* trace.value.writePhase("instance.disposing", "started", ctx.directory)
      yield* Effect.logInfo("disposing instance").pipe(Effect.annotateLogs("directory", ctx.directory))
      yield* Effect.promise(() => runDisposers(ctx.directory))
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
      yield* health.remove(ctx.directory)
      if (Option.isSome(trace)) yield* trace.value.writePhase("instance.disposed", "completed", ctx.directory)
    })

    const disposeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, ctx: InstanceContext) {
      if (cache.get(directory) !== entry) return false
      yield* disposeContext(ctx)
      if (cache.get(directory) !== entry) return false
      cache.delete(directory)
      return true
    })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = AppFileSystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = cache.get(directory)
          if (existing) return yield* restore(Deferred.await(existing.deferred))
          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* forkInstance(
            "instance.load",
            Effect.gen(function* () {
              yield* Effect.logInfo("creating instance").pipe(Effect.annotateLogs("directory", directory))
              yield* completeLoad(directory, input, entry)
            }),
          )
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.load")) as any
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = AppFileSystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directory)
          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* forkInstance(
            "instance.reload",
            Effect.gen(function* () {
              const trace = yield* Effect.serviceOption(InstanceTrace.Service)
              if (Option.isSome(trace)) yield* trace.value.writePhase("instance.reloading", "started", directory)
              yield* Effect.logInfo("reloading instance").pipe(Effect.annotateLogs("directory", directory))
              if (previous) {
                yield* Deferred.await(previous.deferred).pipe(Effect.ignore)
                yield* Effect.promise(() => runDisposers(directory))
                yield* emitDisposed({ directory, project: input.project?.id })
              }
              yield* completeLoad(directory, input, entry)
            }),
          )
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload")) as any
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return yield* disposeContext(ctx)

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(ctx.directory, entry, ctx).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed").pipe(
                Effect.annotateLogs({ key: item[0], cause: exit.cause }),
              )
              yield* removeEntry(item[0], item[1])
              yield* health.remove(item[0])
              return
            }
            yield* disposeEntry(item[0], item[1], exit.value)
          }),
        { discard: true },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))))

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      reload,
      dispose,
      disposeAll,
      provide,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Project.defaultLayer))

export * as InstanceStore from "./instance-store"
