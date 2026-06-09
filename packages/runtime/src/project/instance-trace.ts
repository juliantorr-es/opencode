import { Cause, Context, Effect, Layer } from "effect"
import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { RuntimeFlags } from "@/effect/runtime-flags"

const TRACE_FILE = "instance-startup.jsonl"

export type TracePhase =
  | "instance.boot.start"
  | "instance.boot.config"
  | "instance.boot.plugins"
  | "instance.boot.services"
  | "instance.boot.complete"
  | "instance.boot.failed"
  | "instance.booting"
  | "instance.ready"
  | "instance.failed"
  | "instance.disposing"
  | "instance.disposed"
  | "instance.reloading"

export interface TraceEntry {
  timestamp: string
  phase: TracePhase
  status: "started" | "completed" | "degraded" | "failed"
  bootId: string
  message?: string
  errorCode?: string
  cause?: string
  isDie?: boolean
  lastPhase?: TracePhase
}

export interface Interface {
  readonly bootId: string
  writePhase(phase: TracePhase, status: "started" | "completed" | "degraded", message?: string): Effect.Effect<void>
  writeFailure(phase: TracePhase, errorCode: string, message: string, cause?: Cause.Cause<unknown>): Effect.Effect<void>
  latestEntry(): Effect.Effect<TraceEntry | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@tribunus/InstanceTrace") {}

const ensureWrite = (path: string, entry: TraceEntry): Effect.Effect<void, Error> =>
  Effect.promise(() =>
    mkdir(dirname(path), { recursive: true }).then(() =>
      appendFile(path, JSON.stringify(entry) + "\n")
    )
  )

export const layer: Layer.Layer<Service, never, RuntimeFlags.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const bootId = randomUUID()
    const tracePath = `${process.cwd()}/${TRACE_FILE}`
    let lastPhase: TracePhase | undefined

    const writePhase = (phase: TracePhase, status: "started" | "completed" | "degraded", message?: string): Effect.Effect<void> => {
      if (flags.disableInstanceTrace) return Effect.void
      lastPhase = phase
      return ensureWrite(tracePath, {
        timestamp: new Date().toISOString(),
        phase,
        status,
        bootId,
        ...(message ? { message } : {}),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            console.error("[InstanceTrace] writePhase failed:", Cause.pretty(cause)),
          ),
        ),
      )
    }

    const writeFailure = (
      phase: TracePhase,
      errorCode: string,
      message: string,
      cause?: Cause.Cause<unknown>,
    ): Effect.Effect<void> => {
      if (flags.disableInstanceTrace) return Effect.void
      const entry: TraceEntry = {
        timestamp: new Date().toISOString(),
        phase,
        status: "failed",
        errorCode,
        message,
        cause: cause ? Cause.pretty(cause) : undefined,
        isDie: cause ? cause.reasons.some(Cause.isDieReason) : undefined,
        bootId,
        ...(lastPhase !== phase && lastPhase ? { lastPhase } : {}),
      }
      lastPhase = phase
      return ensureWrite(tracePath, entry).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            console.error("[InstanceTrace] writeFailure failed:", Cause.pretty(cause)),
          ),
        ),
      )
    }

    const latestEntry = (): Effect.Effect<TraceEntry | undefined> =>
      Effect.promise(async () => {
        // Import fs/promises readFile for reading the trace
        const { readFile } = await import("node:fs/promises")
        try {
          const content = await readFile(tracePath, "utf-8")
          const lines = content.trim().split("\n")
          if (lines.length === 0) return undefined
          return JSON.parse(lines[lines.length - 1]) as TraceEntry
        } catch {
          return undefined
        }
      })

    yield* writePhase("instance.booting", "started", `trace:${bootId}`)

    return Service.of({
      bootId,
      writePhase,
      writeFailure,
      latestEntry,
    })
  }),
)

export * as InstanceTrace from "./instance-trace"
