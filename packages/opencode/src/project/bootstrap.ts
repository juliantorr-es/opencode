import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { Bus } from "../bus"
import { InstanceState } from "@/effect/instance-state"
import { FileWatcher } from "@/file/watcher"
import { ShareNext } from "@/share/share-next"
import { Effect, Exit, Layer, Option, Ref } from "effect"
import { InstanceTrace } from "./instance-trace"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"
import { Reference } from "@/reference/reference"
import { classifyError } from "@/diagnostic/instance-failure-codes"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const file = yield* File.Service
    const fileWatcher = yield* FileWatcher.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const reference = yield* Reference.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const trace = yield* Effect.serviceOption(InstanceTrace.Service)
      yield* Effect.logInfo("bootstrapping").pipe(Effect.annotateLogs("directory", ctx.directory))

      const tracePhase = (
        phase: InstanceTrace.TracePhase,
        status: "started" | "completed",
        msg?: string,
      ): Effect.Effect<void> =>
        Option.isSome(trace) ? trace.value.writePhase(phase, status, msg) : Effect.void

      yield* tracePhase("instance.boot.start", "started", ctx.directory)
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      yield* tracePhase("instance.boot.config", "completed")
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      yield* tracePhase("instance.boot.plugins", "completed")
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* tracePhase("instance.boot.services", "started")
      const failuresRef = yield* Ref.make<Array<string>>([])
      yield* Effect.forEach(
        [
          { name: "reference", svc: reference },
          { name: "lsp", svc: lsp },
          { name: "shareNext", svc: shareNext },
          { name: "format", svc: format },
          { name: "file", svc: file },
          { name: "fileWatcher", svc: fileWatcher },
          { name: "vcs", svc: vcs },
          { name: "snapshot", svc: snapshot },
          { name: "project", svc: project },
        ],
        ({ svc, name }) =>
          svc.init().pipe(
            Effect.exit,
            Effect.flatMap(
              Exit.match({
                onFailure: (cause) => {
                  const classified = classifyError(cause, "instance.boot.services", name)
                  return Effect.gen(function* () {
                    yield* Ref.update(failuresRef, (arr) => [...arr, name])
                    yield* Effect.logWarning("init failed", { ...classified, cause })
                  })
                },
                onSuccess: () => Effect.void,
              }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
      const failures = yield* Ref.get(failuresRef)
      const status = failures.length === 0 ? "ready" as const
        : failures.length < 9 ? "degraded" as const
        : "failed" as const
      yield* tracePhase("instance.boot.complete", "completed")
      return { status, failedServices: failures }
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Bus.layer,
    Config.defaultLayer,
    File.defaultLayer,
    FileWatcher.defaultLayer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Plugin.defaultLayer,
    Project.defaultLayer,
    Reference.defaultLayer,
    ShareNext.defaultLayer,
    Snapshot.defaultLayer,
    Vcs.defaultLayer,
  ]),
)

export * as InstanceBootstrap from "./bootstrap"
