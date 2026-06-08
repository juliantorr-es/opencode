import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./lesson-register.txt"

const CategorySchema = Schema.Literals(["codebase", "workflow", "architecture", "tool", "timing", "convention"])

const Parameters = Schema.Struct({
  action: Schema.Literals(["record", "read", "list"]).annotate({
    description: "What to do: record a new lesson, read matching lessons, or list categories with counts",
  }),
  category: Schema.optional(CategorySchema).annotate({
    description: "Lesson category — required for record, optional filter for read/list",
  }),
  insight: Schema.optional(Schema.String).annotate({
    description: "One-sentence lesson — required for record action",
  }),
  context: Schema.optional(Schema.String).annotate({
    description: "What triggered this insight — required for record action",
  }),
  source_session: Schema.optional(Schema.String).annotate({
    description: "Session identifier (defaults to current session ID)",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max results (default 20, for read/list)",
  }),
})

interface LessonRecord {
  id: string
  category: string
  insight: string
  context: string
  source_session: string
  created_at: number
}

export const LessonRegisterTool = Tool.define(
  "lesson_register",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const lessonsDir = path.join(instance.directory, ".rig", "lessons")
          const lessonsPath = path.join(lessonsDir, "lessons.v1.jsonl")

          const action = params.action

          if (action === "record") {
            if (!params.insight) {
              return {
                title: "lesson_register",
                metadata: { action: "record", status: "fail" },
                output: JSON.stringify({ error: "insight is required for record action" }),
              }
            }
            if (!params.context) {
              return {
                title: "lesson_register",
                metadata: { action: "record", status: "fail" },
                output: JSON.stringify({ error: "context is required for record action" }),
              }
            }

            const lesson: LessonRecord = {
              id: "lsn_" + Date.now().toString(36),
              category: params.category ?? "workflow",
              insight: params.insight,
              context: params.context,
              source_session: params.source_session ?? ctx.sessionID,
              created_at: Date.now(),
            }

            yield* fs.ensureDir(lessonsDir)
            yield* fs.appendLine(lessonsPath, JSON.stringify(lesson))

            return {
              title: "lesson_register",
              metadata: { action: "record", lesson_id: lesson.id, category: lesson.category },
              output: JSON.stringify({ status: "recorded", lesson }),
            }
          }

          if (action === "list") {
            yield* fs.ensureDir(lessonsDir)
            const exists = yield* fs.existsSafe(lessonsPath)
            if (!exists) {
              return {
                title: "lesson_register",
                metadata: { action: "list", categories: 0 },
                output: JSON.stringify({ categories: [] }),
              }
            }

            const content = yield* fs.readFileString(lessonsPath)
            const lines = content.trim().split("\n").filter(Boolean)
            const categoryCounts: Record<string, number> = {}
            for (const line of lines) {
              try {
                const record = JSON.parse(line) as LessonRecord
                categoryCounts[record.category] = (categoryCounts[record.category] ?? 0) + 1
              } catch { /* skip corrupt lines */ }
            }

            return {
              title: "lesson_register",
              metadata: { action: "list", categories: Object.keys(categoryCounts).length },
              output: JSON.stringify({ categories: categoryCounts }),
            }
          }

          yield* fs.ensureDir(lessonsDir)
          const exists = yield* fs.existsSafe(lessonsPath)
          if (!exists) {
            return {
              title: "lesson_register",
              metadata: { action: "read", count: 0 },
              output: JSON.stringify({ lessons: [] }),
            }
          }

          const content = yield* fs.readFileString(lessonsPath)
          const lines = content.trim().split("\n").filter(Boolean)
          const records: LessonRecord[] = []
          for (const line of lines) {
            try {
              records.push(JSON.parse(line) as LessonRecord)
            } catch { /* skip corrupt lines */ }
          }

          let filtered = records
          if (params.category) {
            filtered = filtered.filter((r) => r.category === params.category)
          }
          if (params.source_session) {
            filtered = filtered.filter((r) => r.source_session === params.source_session)
          }
          filtered.sort((a, b) => b.created_at - a.created_at)

          const limit = params.limit ?? 20
          const result = filtered.slice(0, limit)

          return {
            title: "lesson_register",
            metadata: { action: "read", count: result.length, total_filtered: filtered.length },
            output: JSON.stringify({ lessons: result }),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as LessonRegister from "./lesson-register"
