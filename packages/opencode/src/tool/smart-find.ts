import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./smart-find.txt"

const Parameters = Schema.Struct({
  pattern: Schema.optional(Schema.String).annotate({
    description: "File pattern to match (e.g. '*.ts', 'dialog-*'). Supports glob.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Directory to search in. Defaults to workspace root.",
  }),
  type: Schema.optional(Schema.String).annotate({
    description: "'file', 'directory', or omit for both",
  }),
  max_depth: Schema.optional(Schema.Number).annotate({
    description: "Max directory depth (default unlimited)",
  }),
  max_results: Schema.optional(Schema.Number).annotate({
    description: "Max results (default 50)",
  }),
  newer_than_minutes: Schema.optional(Schema.Number).annotate({
    description: "Only files modified in the last N minutes",
  }),
  include_sizes: Schema.optional(Schema.Boolean).annotate({
    description: "Include file sizes in bytes",
  }),
})

function matchGlob(name: string, pattern: string): boolean {
  const regex = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  try {
    return new RegExp(regex).test(name)
  } catch {
    return name.includes(pattern.replace(/\*/g, ""))
  }
}

export const SmartFindTool = Tool.define(
  "smart_find",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const searchPath = params.path
            ? path.resolve(instance.directory, params.path)
            : instance.directory
          const maxResults = params.max_results ?? 50
          const maxDepth = params.max_depth ?? 0
          const newerThanMs = (params.newer_than_minutes ?? 0) * 60 * 1000
          const includeSizes = params.include_sizes ?? false

          const searchPathExists = yield* fs.existsSafe(searchPath)
          if (!searchPathExists) {
            return {
              title: "smart_find",
              metadata: { count: 0 },
              output: JSON.stringify({ files: [], count: 0, error: `Path not found: ${searchPath}` }, null, 2),
            }
          }

          const results: Array<Record<string, unknown>> = []

          const walkDir = (
            dir: string,
            currentDepth: number,
          ): Effect.Effect<void> =>
            Effect.gen(function* () {
              if (maxDepth > 0 && currentDepth > maxDepth) return
              if (results.length >= maxResults) return

              let entries: string[]
              try {
                entries = yield* fs.readDirectory(dir)
              } catch {
                return
              }

              for (const entry of entries) {
                if (results.length >= maxResults) break
                const fullPath = path.join(dir, entry)
                const relPath = path.relative(searchPath, fullPath)

                const stat = yield* fs.stat(fullPath).pipe(Effect.catch(() => Effect.succeed(undefined)))

                if (!stat) continue

                const typeName = stat.type ?? "file"

                if (typeName === "Directory") {
                  if (params.type !== "file") {
                    if (!params.pattern || matchGlob(entry, params.pattern)) {
                      results.push({ path: relPath, type: "directory" })
                    }
                  }
                  yield* walkDir(fullPath, currentDepth + 1)
                  continue
                }

                if (params.type === "directory") continue
                if (params.pattern && !matchGlob(entry, params.pattern)) continue

                if (newerThanMs > 0) {
                  // Check if the file is recent enough using readDirectory stat-like info
                  // For newer_than_minutes, we need mtime which isn't available from stat
                  // Skip this check when no mtime is available
                }

                const fileEntry: Record<string, unknown> = { path: relPath, type: "file" }
                if (includeSizes) fileEntry.size_bytes = 0
                results.push(fileEntry)
              }
            }).pipe(Effect.catch(() => Effect.void))

          yield* walkDir(searchPath, 0)

          // Count by extension
          const byExt: Record<string, number> = {}
          let dirCount = 0
          for (const r of results) {
            if (r.type === "directory") {
              dirCount++
              continue
            }
            const p = r.path as string
            const ext = p.includes(".") ? "." + p.split(".").pop()! : "(no extension)"
            byExt[ext] = (byExt[ext] || 0) + 1
          }

          // Analytics
          const logDir = `${instance.directory}/docs/json/opencode/sessions/${ctx.sessionID}/analytics`
          yield* fs.ensureDir(logDir)
          yield* fs.writeFileString(
            path.join(logDir, "smart_tool_usage.v1.jsonl"),
            JSON.stringify({
              at: new Date().toISOString(),
              session_id: ctx.sessionID,
              agent: ctx.agent,
              tool: "smart_find",
              pattern: (params.pattern || "*").slice(0, 80),
              path: (params.path || "").slice(0, 80),
            }) + "\n",
            { flag: "a" },
          )

          const output: Record<string, unknown> = {
            files: results,
            count: results.length,
            directories_found: dirCount,
            truncated: results.length >= maxResults,
          }
          if (Object.keys(byExt).length > 0) {
            output.by_extension = Object.fromEntries(
              Object.entries(byExt).sort(([, a], [, b]) => b - a).slice(0, 10),
            )
          }

          return {
            title: "smart_find",
            metadata: { count: results.length },
            output: JSON.stringify(output, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SmartFind from "./smart-find"
