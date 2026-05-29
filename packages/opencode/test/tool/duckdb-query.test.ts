import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { DuckDBQueryTool } from "../../src/tool/duckdb-query"
import { DuckDB } from "@/storage/db.duckdb"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"

function makeFakeClient(rows: Record<string, unknown>[]) {
  return {
    all: async <T>(_sql: string) => rows as T[],
    get: async <T>(_sql: string) => (rows[0] ?? undefined) as T,
    run: async (_sql: string) => {},
    close: async () => {},
  }
}

function makeCtx(): Tool.Context {
  return {
    sessionID: "s" as any,
    messageID: "m" as any,
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

const mockAgentLayer = Layer.mock(Agent.Service, {
  get: () =>
    Effect.succeed({
      name: "build",
      permission: [],
    } as any),
  list: () => Effect.succeed([]),
  defaultInfo: () => Effect.succeed({ name: "build", permission: [] } as any),
  defaultAgent: () => Effect.succeed("build"),
  generate: () =>
    Effect.succeed({
      identifier: "test",
      whenToUse: "test",
      systemPrompt: "test",
    }),
})

const it = testEffect(
  Layer.mergeAll(
    Layer.succeed(DuckDB.Service, makeFakeClient([{ count: 42 }]) as any),
    Truncate.defaultLayer,
    mockAgentLayer,
  ),
)

describe("DuckDBQueryTool", () => {
  it.effect("registers with correct id", () =>
    Effect.gen(function* () {
      const info = yield* DuckDBQueryTool
      expect(info.id).toBe("duckdb_query")
    }),
  )

  it.effect("appends LIMIT when not present", () =>
    Effect.gen(function* () {
      const captured: string[] = []
      const capturingClient = {
        all: async (sql: string) => {
          captured.push(sql)
          return []
        },
        get: async () => undefined,
        run: async () => {},
        close: async () => {},
      }

      const info = yield* DuckDBQueryTool.pipe(
        Effect.provide(Layer.succeed(DuckDB.Service, capturingClient as any)),
      )
      const tool = yield* info.init()
      yield* tool.execute({ sql: "SELECT 1" }, makeCtx())
      expect(captured[0]).toMatch(/LIMIT\s+1000/i)
    }),
  )

  it.effect("does not double-append LIMIT", () =>
    Effect.gen(function* () {
      const captured: string[] = []
      const capturingClient = {
        all: async (sql: string) => {
          captured.push(sql)
          return []
        },
        get: async () => undefined,
        run: async () => {},
        close: async () => {},
      }

      const info = yield* DuckDBQueryTool.pipe(
        Effect.provide(Layer.succeed(DuckDB.Service, capturingClient as any)),
      )
      const tool = yield* info.init()
      yield* tool.execute({ sql: "SELECT * FROM t LIMIT 10" }, makeCtx())
      expect(captured[0]).toBe("SELECT * FROM t LIMIT 10")
    }),
  )
})
