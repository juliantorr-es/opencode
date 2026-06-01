import { describe, expect } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "os"
import path from "path"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceTrace } from "../../src/project/instance-trace"
import { testEffect } from "../lib/effect"

const it = testEffect(RuntimeFlags.layer())

const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function traceTest(
  testFn: (trace: InstanceTrace.Interface, dir: string) => Effect.Effect<void>,
  options?: { disableInstanceTrace?: boolean },
) {
  return Effect.gen(function* () {
    const dir = path.join(os.tmpdir(), "opencode-test-" + Math.random().toString(36).slice(2))
    yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
    )

    const originalCwd = process.cwd()
    process.chdir(dir)
    yield* Effect.addFinalizer(() => Effect.sync(() => process.chdir(originalCwd)))

    const flagsLayer = RuntimeFlags.layer({ disableInstanceTrace: options?.disableInstanceTrace ?? false })

    yield* Effect.gen(function* () {
      const trace = yield* InstanceTrace.Service
      yield* testFn(trace, dir)
    }).pipe(Effect.provide(InstanceTrace.layer.pipe(Layer.provide(flagsLayer))))
  })
}

const readTraceFile = (dir: string) =>
  Effect.promise(async () => {
    const content = await fs.readFile(path.join(dir, "instance-startup.jsonl"), "utf-8")
    return content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
  })

const traceFileExists = (dir: string) =>
  Effect.promise(() =>
    fs
      .access(path.join(dir, "instance-startup.jsonl"))
      .then(() => true)
      .catch(() => false),
  )

describe("InstanceTrace", () => {
  it.live("builds with a valid UUID v4 bootId", () =>
    traceTest((trace) =>
      Effect.sync(() => {
        expect(typeof trace.bootId).toBe("string")
        expect(uuidV4Regex.test(trace.bootId)).toBe(true)
      }),
    ),
  )

  it.live("writePhase writes valid JSONL entry", () =>
    traceTest((trace, dir) =>
      Effect.gen(function* () {
        yield* trace.writePhase("instance.boot.start", "started", "test message")
        const entries = yield* readTraceFile(dir)
        // first entry is the automatic "instance.booting", last is our write
        const last = entries[entries.length - 1]
        expect(last.phase).toBe("instance.boot.start")
        expect(last.status).toBe("started")
        expect(last.message).toBe("test message")
        expect(last.bootId).toBe(trace.bootId)
        expect(new Date(last.timestamp).toISOString()).toBe(last.timestamp)
      }),
    ),
  )

  it.live("writePhase writes multiple entries in order", () =>
    traceTest((trace, dir) =>
      Effect.gen(function* () {
        yield* trace.writePhase("instance.boot.config", "started")
        yield* trace.writePhase("instance.boot.config", "completed")
        yield* trace.writePhase("instance.boot.plugins", "started")
        const entries = yield* readTraceFile(dir)
        expect(entries.length).toBe(4) // booting + 3 writes
        expect(entries[1].phase).toBe("instance.boot.config")
        expect(entries[1].status).toBe("started")
        expect(entries[2].phase).toBe("instance.boot.config")
        expect(entries[2].status).toBe("completed")
        expect(entries[3].phase).toBe("instance.boot.plugins")
      }),
    ),
  )

  it.live("writeFailure writes valid JSONL entry with error details", () =>
    traceTest((trace, dir) =>
      Effect.gen(function* () {
        yield* trace.writeFailure("instance.boot.failed", "ERR_CONFIG", "failed to load config")
        const entries = yield* readTraceFile(dir)
        const last = entries[entries.length - 1]
        expect(last.phase).toBe("instance.boot.failed")
        expect(last.status).toBe("failed")
        expect(last.errorCode).toBe("ERR_CONFIG")
        expect(last.message).toBe("failed to load config")
        expect(last.bootId).toBe(trace.bootId)
        expect(last.isDie).toBeUndefined()
      }),
    ),
  )

  it.live("writeFailure records cause and isDie when cause is provided", () =>
    traceTest((trace, dir) =>
      Effect.gen(function* () {
        yield* trace.writeFailure(
          "instance.boot.failed",
          "ERR_INNER",
          "wrapped failure",
          Cause.fail(new Error("inner error")),
        )
        const entries = yield* readTraceFile(dir)
        const last = entries[entries.length - 1]
        expect(last.status).toBe("failed")
        expect(last.errorCode).toBe("ERR_INNER")
        expect(last.cause).toBeDefined()
        expect(typeof last.cause).toBe("string")
        expect(last.cause).toContain("inner error")
        expect(last.isDie).toBe(false)
      }),
    ),
  )

  it.live("writeFailure records lastPhase when transitioning from a different phase", () =>
    traceTest((trace, dir) =>
      Effect.gen(function* () {
        yield* trace.writePhase("instance.boot.config", "started")
        yield* trace.writeFailure("instance.boot.failed", "ERR_ABORT", "config aborted")
        const entries = yield* readTraceFile(dir)
        const last = entries[entries.length - 1]
        expect(last.phase).toBe("instance.boot.failed")
        expect(last.lastPhase).toBe("instance.boot.config")
      }),
    ),
  )

  it.live("kill switch disables all tracing when disableInstanceTrace is true", () =>
    traceTest(
      (trace, dir) =>
        Effect.gen(function* () {
          yield* trace.writePhase("instance.boot.config", "started")
          yield* trace.writeFailure("instance.boot.failed", "ERR_TEST", "test failure")

          const exists = yield* traceFileExists(dir)
          expect(exists).toBe(false)

          const entry = yield* trace.latestEntry()
          expect(entry).toBeUndefined()
        }),
      { disableInstanceTrace: true },
    ),
  )

  it.live("write failures are caught and do not crash", () =>
    traceTest((trace, dir) =>
      Effect.gen(function* () {
        // Replace the trace file with a directory so subsequent writes to
        // that path will fail — the catchAllCause guard must prevent a crash.
        yield* Effect.promise(() => fs.unlink(path.join(dir, "instance-startup.jsonl")))
        yield* Effect.promise(() => fs.mkdir(path.join(dir, "instance-startup.jsonl")))

        yield* trace.writePhase("instance.boot.config", "started")
        yield* trace.writeFailure("instance.boot.failed", "ERR_IO", "should not crash")
      }),
    ),
  )

  it.live("latestEntry reads back the last written entry", () =>
    traceTest((trace) =>
      Effect.gen(function* () {
        yield* trace.writePhase("instance.boot.config", "started")
        yield* trace.writePhase("instance.boot.config", "completed")
        const entry = yield* trace.latestEntry()
        expect(entry).not.toBeUndefined()
        expect(entry!.phase).toBe("instance.boot.config")
        expect(entry!.status).toBe("completed")
        expect(entry!.bootId).toBe(trace.bootId)
      }),
    ),
  )

  it.live("latestEntry returns undefined when trace file does not exist", () =>
    Effect.gen(function* () {
      const dir = path.join(os.tmpdir(), "opencode-test-" + Math.random().toString(36).slice(2))
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
      )

      const originalCwd = process.cwd()
      process.chdir(dir)
      yield* Effect.addFinalizer(() => Effect.sync(() => process.chdir(originalCwd)))

      yield* Effect.gen(function* () {
        const trace = yield* InstanceTrace.Service
        // Remove the trace file written at construction
        yield* Effect.promise(() => fs.unlink(path.join(dir, "instance-startup.jsonl")))
        const entry = yield* trace.latestEntry()
        expect(entry).toBeUndefined()
      }).pipe(Effect.provide(InstanceTrace.layer.pipe(Layer.provide(RuntimeFlags.layer()))))
    }),
  )

  it.live("writes initial instance.booting phase on construction", () =>
    traceTest((trace, dir) =>
      Effect.gen(function* () {
        const entries = yield* readTraceFile(dir)
        expect(entries.length).toBe(1)
        const first = entries[0]
        expect(first.phase).toBe("instance.booting")
        expect(first.status).toBe("started")
        expect(first.message).toContain("trace:")
        expect(first.bootId).toBe(trace.bootId)
      }),
    ),
  )
})
