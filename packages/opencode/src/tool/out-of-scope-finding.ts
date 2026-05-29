import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./out-of-scope-finding.txt"

const Parameters = Schema.Struct({
  affected_files: Schema.String.annotations({ description: "JSON array of affected file paths" }),
  language: Schema.String.annotations({ description: "Language/subsystem" }),
  why_matters: Schema.String.annotations({ description: "Why this finding matters" }),
  best_practice_anchor: Schema.String.annotations({ description: "Best practice reference" }),
  recommended_slice: Schema.String.annotations({ description: "Recommended future work slice" }),
})

export const OutOfScopeFindingTool = Tool.define(
  "out_of_scope_finding",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const findingsPath = path.join(instance.directory, "docs", "findings", "out-of-scope-findings.jsonl")
          const registryDir = path.join(instance.directory, "docs", "json", "opencode", "registry")
          const registryPath = path.join(registryDir, "artifacts.v1.jsonl")
          const now = new Date().toISOString()

          const filesParsed: string[] = JSON.parse(params.affected_files)
          const dedupKey = createHash("sha256")
            .update(JSON.stringify([...filesParsed].sort()) + "|" + params.why_matters)
            .digest("hex")
            .slice(0, 16)

          // Part 1: Write to findings registry
          let alreadyRecorded = false
          const findingsExists = yield* fs.existsSafe(findingsPath)
          if (findingsExists) {
            const content = yield* fs.readFileString(findingsPath)
            for (const line of content.split("\n").filter(Boolean)) {
              try {
                const existing = JSON.parse(line)
                const existingKey = createHash("sha256")
                  .update(JSON.stringify([...(existing.affected_files ?? [])].sort()) + "|" + (existing.why_matters ?? ""))
                  .digest("hex")
                  .slice(0, 16)
                if (existingKey === dedupKey) { alreadyRecorded = true; break }
              } catch { continue }
            }
          }

          if (!alreadyRecorded) {
            yield* fs.ensureDir(path.dirname(findingsPath))
            const record = {
              schema_version: "v1", affected_files: filesParsed,
              language: params.language, why_matters: params.why_matters,
              best_practice_anchor: params.best_practice_anchor,
              recommended_slice: params.recommended_slice,
              session_id: ctx.sessionID, recorded_at: now,
            }
            yield* fs.writeFileString(findingsPath, JSON.stringify(record) + "\n", { flag: "a" })
          }

          // Part 2: Publish to cross-session registry
          const regDedupKey = createHash("sha256")
            .update(`${ctx.sessionID}|debt|${params.why_matters}`)
            .digest("hex")
            .slice(0, 16)
          let alreadyInRegistry = false
          const regExists = yield* fs.existsSafe(registryPath)
          if (regExists) {
            const content = yield* fs.readFileString(registryPath)
            for (const line of content.split("\n").filter(Boolean)) {
              try {
                const existing = JSON.parse(line)
                if (existing.dedup_key === regDedupKey) { alreadyInRegistry = true; break }
              } catch { continue }
            }
          }

          if (!alreadyInRegistry) {
            yield* fs.ensureDir(registryDir)
            const thirtyDays = 30 * 24 * 3600
            const regRecord = {
              schema_version: "v1",
              finding_id: `${ctx.sessionID.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}-debt`,
              dedup_key: regDedupKey, session_id: ctx.sessionID,
              finding_type: "debt",
              summary: `[${params.language}] ${params.why_matters.slice(0, 200)}`,
              source_artifact: findingsPath,
              relevance_profiles: ["architecture", "execution", "cartography"],
              confidence: 0.9, ttl_seconds: thirtyDays,
              recommended_slice: params.recommended_slice,
              published_at: now,
              expires_at: new Date(Date.now() + thirtyDays * 1000).toISOString(),
            }
            yield* fs.writeFileString(registryPath, JSON.stringify(regRecord) + "\n", { flag: "a" })
          }

          const result = {
            status: alreadyRecorded ? "duplicate" : "recorded",
            finding_recorded: !alreadyRecorded,
            file_count: filesParsed.length,
            cross_session_published: !alreadyInRegistry,
            ttl: "30 days",
          }
          return {
            title: "out_of_scope_finding",
            metadata: { status: result.status, file_count: result.file_count },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as OutOfScopeFinding from "./out-of-scope-finding"
