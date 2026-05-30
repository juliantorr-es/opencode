import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import path from "path"
import DESCRIPTION from "./session-diff.txt"

const Parameters = Schema.Struct({
  session_id: Schema.optional(Schema.String).annotate({
    description: "Session to summarize (defaults to current session)",
  }),
  format: Schema.optional(Schema.Literals(["summary", "full"])).annotate({
    description: "summary | full — summary returns counts only, full includes file lists",
  }),
})

function getSessionDir(instanceDir: string, sid: string): string {
  return path.join(instanceDir, "docs", "json", "opencode", "sessions", sid)
}

export const SessionDiffTool = Tool.define(
  "session_diff",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const git = yield* Git.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const sid = params.session_id ?? String(ctx.sessionID)
          const formatMode = params.format ?? "summary"
          const sessionDir = getSessionDir(instance.directory, sid)
          const editLogPath = path.join(sessionDir, "edits", "edit_log.v1.jsonl")

          // Collect stats
          const filesCreated = new Set<string>()
          const filesModified = new Set<string>()
          const filesDeleted = new Set<string>()
          const perPackage: Record<string, { count: number; created: number; modified: number }> = {}
          const agentsInvolved: Record<string, number> = {}
          let totalEdits = 0

          // Try to read edit log
          const editLogExists = yield* fs.existsSafe(editLogPath)
          if (editLogExists) {
            const content = yield* fs.readFileString(editLogPath)
            for (const line of content.trim().split("\n").filter(Boolean)) {
              try {
                const entry = JSON.parse(line)
                const filePath = entry.file ?? ""
                const agent = entry.agent ?? ""
                totalEdits++
                if (agent) {
                  agentsInvolved[agent] = (agentsInvolved[agent] ?? 0) + 1
                }

                // Determine package
                let pkg = "root"
                if (filePath.startsWith("packages/")) {
                  pkg = filePath.split("/")[1]
                } else if (filePath.startsWith(".")) {
                  pkg = "config"
                }

                const action = entry.action ?? entry.change_summary ?? ""
                if (action.toLowerCase().includes("create") || action.toLowerCase().includes("new")) {
                  filesCreated.add(filePath)
                  perPackage[pkg] ??= { count: 0, created: 0, modified: 0 }
                  perPackage[pkg].created++
                } else if (action.toLowerCase().includes("delete") || action.toLowerCase().includes("remove")) {
                  filesDeleted.add(filePath)
                } else if (filePath) {
                  filesModified.add(filePath)
                  perPackage[pkg] ??= { count: 0, created: 0, modified: 0 }
                  perPackage[pkg].modified++
                }

                if (filePath) {
                  perPackage[pkg] ??= { count: 0, created: 0, modified: 0 }
                  perPackage[pkg].count++
                }
              } catch {
                // skip malformed lines
              }
            }
          }

          // If no edits found, try git diff
          let netLines = "+0/-0"
          if (totalEdits === 0 || formatMode === "full") {
            // Always try git for line counts
            try {
              const gitResult = yield* git.run(["diff", "--stat", "HEAD"], { cwd: instance.directory })
              if (gitResult.exitCode === 0 && gitResult.text().trim()) {
                const lines = gitResult.text().trim().split("\n")
                const lastLine = lines[lines.length - 1]
                if (lastLine) netLines = lastLine.trim()

                // If no edit log or full mode, also get file list from git
                if (totalEdits === 0) {
                  const nameStatus = yield* git.run(["diff", "--name-status", "HEAD"], { cwd: instance.directory })
                  if (nameStatus.exitCode === 0 && nameStatus.text().trim()) {
                    for (const line of nameStatus.text().trim().split("\n")) {
                      if (!line.trim()) continue
                      const parts = line.split("\t")
                      if (parts.length >= 2) {
                        const statusCode = parts[0]
                        const fpath = parts.slice(1).join("\t").trim()
                        if (!fpath) continue

                        let pkg = "root"
                        if (fpath.startsWith("packages/")) pkg = fpath.split("/")[1]
                        else if (fpath.startsWith(".")) pkg = "config"

                        perPackage[pkg] ??= { count: 0, created: 0, modified: 0 }
                        perPackage[pkg].count++
                        totalEdits++

                        if (statusCode.startsWith("A")) {
                          filesCreated.add(fpath)
                          perPackage[pkg].created++
                        } else if (statusCode.startsWith("D")) {
                          filesDeleted.add(fpath)
                        } else {
                          filesModified.add(fpath)
                          perPackage[pkg].modified++
                        }
                      }
                    }
                  }
                }
              }
            } catch {
              // git failed, use edit log data only
            }
          }

          // Build result
          const result: Record<string, unknown> = {
            session: sid,
            files_created: filesCreated.size,
            files_modified: filesModified.size,
            files_deleted: filesDeleted.size,
            total_edits: totalEdits,
            net_lines: netLines,
            per_package: perPackage,
            agents_involved: agentsInvolved,
          }

          if (formatMode === "full") {
            result.created_list = [...filesCreated].sort()
            result.modified_list = [...filesModified].sort()
            result.deleted_list = [...filesDeleted].sort()
          }

          return {
            title: `session_diff: ${sid}`,
            metadata: {
              session: sid,
              format: formatMode,
              files_created: filesCreated.size,
              files_modified: filesModified.size,
              files_deleted: filesDeleted.size,
              total_edits: totalEdits,
              net_lines: netLines,
            },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SessionDiff from "./session-diff"
