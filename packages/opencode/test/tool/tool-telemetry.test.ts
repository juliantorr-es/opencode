import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, AppFileSystem.defaultLayer),
)

const params = Schema.Struct({ input: Schema.String })

function makeCtx(): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    callID: undefined,
    metadata() { return Effect.void },
    ask() { return Effect.void },
  }
}

function makeCtxWithCallID(callID: string): Tool.Context {
  return { ...makeCtx(), callID }
}

describe("Tool telemetry", () => {
  it.effect("smoke: basic tool execution works", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "smoke-test",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "ok", output: "done", metadata: {} })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      const result = yield* execute({ input: "hello" }, makeCtx())
      expect(result.output).toBe("done")
    }),
  )

  it.effect("concurrent invocations: 8 calls with distinct callIDs produce results", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "concurrent",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "ok", output: "done", metadata: {} })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      const calls = Array.from({ length: 8 }, (_, i) =>
        execute({ input: "hello" }, makeCtxWithCallID(`call-${i}`)),
      )

      const results = yield* Effect.all(calls, { concurrency: "unbounded" })
      expect(results.length).toBe(8)
      for (const r of results) {
        expect(r.output).toBe("done")
      }
    }),
  )

  it.effect("error taxonomy: InvalidArgumentsError fails execution", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "invalid-args",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            throw new Tool.InvalidArgumentsError({ tool: "test", detail: "bad args" })
          },
        } as any),
      )
      const tool = yield* info.init()

      const exit = yield* Effect.exit(tool.execute({ input: "test" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("error taxonomy: ToolError fails execution", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "tool-err",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            throw new Tool.ToolError({ tool: "test", detail: "tool failed", recoverable: false })
          },
        } as any),
      )
      const tool = yield* info.init()

      const exit = yield* Effect.exit(tool.execute({ input: "test" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("error taxonomy: TimeoutError fails execution", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "timeout",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            throw new Tool.TimeoutError({ tool: "test", detail: "timed out", durationMs: 1000 })
          },
        } as any),
      )
      const tool = yield* info.init()

      const exit = yield* Effect.exit(tool.execute({ input: "test" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("error taxonomy: TransientError fails execution", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "transient",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            throw new Tool.TransientError({ tool: "test", detail: "transient failure" })
          },
        } as any),
      )
      const tool = yield* info.init()

      const exit = yield* Effect.exit(tool.execute({ input: "test" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("error taxonomy: ValidationError fails execution", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "validation",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            throw new Tool.ValidationError({ tool: "test", detail: "invalid field", field: "input" })
          },
        } as any),
      )
      const tool = yield* info.init()

      const exit = yield* Effect.exit(tool.execute({ input: "test" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("UnknownError fallback: raw string error fails execution", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "unknown-err",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            throw "raw string error"
          },
        } as any),
      )
      const tool = yield* info.init()

      const exit = yield* Effect.exit(tool.execute({ input: "test" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("UnknownError: plain Error instance fails execution", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "plain-error",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            throw new Error("plain error message")
          },
        } as any),
      )
      const tool = yield* info.init()

      const exit = yield* Effect.exit(tool.execute({ input: "test" }, makeCtx()))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("write failure resilience: tool succeeds despite telemetry issues", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "resilient",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "ok", output: "done", metadata: {} })
          },
        }),
      )
      const tool = yield* info.init()

      const result = yield* tool.execute({ input: "hello" }, makeCtx())
      expect(result.output).toBe("done")
    }),
  )

  it.effect("output tracking: ExecuteResult contains correct output string", () =>
    Effect.gen(function* () {
      const expected = "Hello, world! 🚀🎉"

      const info = yield* Tool.define(
        "output-test",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "ok", output: expected, metadata: {} })
          },
        }),
      )
      const tool = yield* info.init()

      const result = yield* tool.execute({ input: "hello" }, makeCtx())
      expect(result.output).toBe(expected)
      expect(result.output.length).toBe(expected.length)
      expect(Buffer.byteLength(result.output, "utf8")).toBe(Buffer.byteLength(expected, "utf8"))
    }),
  )

  it.effect("telemetry record: successful result has expected structure", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "fields-test",
        Effect.succeed({
          description: "test",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "ok", output: "done", metadata: {} })
          },
        }),
      )
      const tool = yield* info.init()

      const result = yield* tool.execute({ input: "hello" }, makeCtxWithCallID("test-call-1"))
      expect(result.title).toBe("ok")
      expect(result.output).toBe("done")
    }),
  )
})
