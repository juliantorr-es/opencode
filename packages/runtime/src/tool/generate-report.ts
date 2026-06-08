import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./generate-report.txt"

const Parameters = Schema.Struct({
  session_summary: Schema.String.annotate({ description: "Narrative summary of what was accomplished this session" }),
  next_steps: Schema.optional(Schema.String).annotate({ description: "Recommended next convergent course" }),
})

export const GenerateReportTool = Tool.define(
  "generate_report",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const contextPath = path.join(instance.directory, "docs", "json", "opencode", "sessions", ctx.sessionID, "context", "current.v1.json")
          const reportDir = path.join(instance.directory, "docs", "json", "opencode", "reports")
          const archiveBase = path.join(instance.directory, "docs", "json", "opencode", "archive", ctx.sessionID)
          const reportId = `session-${new Date().toISOString().replace(/[:.]/g, "-")}`
          const reportPath = path.join(reportDir, `${reportId}.v1.json`)
          const now = new Date().toISOString()

          yield* fs.ensureDir(reportDir)
          yield* fs.ensureDir(archiveBase)

          // Load curated context
          let context: Record<string, unknown> = {}
          const ctxExists = yield* fs.existsSafe(contextPath)
          if (ctxExists) {
            try {
              const content = yield* fs.readFileString(contextPath)
              context = JSON.parse(content)
            } catch {}
          }

          const waves = (context.waves ?? {}) as Record<string, unknown>
          const activeFindings = (context.active_findings ?? []) as Array<Record<string, unknown>>
          const activeArtifacts = (context.active_artifacts ?? []) as string[]

          // Build findings by profile
          const findingsByProfile: Record<string, number> = {}
          for (const f of activeFindings) {
            const profiles = (f.relevance_profiles ?? ["uncategorized"]) as string[]
            for (const p of profiles) {
              findingsByProfile[p] = (findingsByProfile[p] ?? 0) + 1
            }
          }

          const report = {
            schema_version: "v1",
            report_id: reportId,
            session_id: ctx.sessionID,
            generated_at: now,
            session_summary: params.session_summary,
            next_steps: params.next_steps ?? null,
            waves_completed: Object.keys(waves),
            wave_details: waves,
            total_findings: activeFindings.length,
            findings_by_profile: findingsByProfile,
            artifacts_consumed: activeArtifacts,
          }

          yield* fs.writeFileString(reportPath, JSON.stringify(report, null, 2))

          // Archive active artifacts
          const archived: Array<{ from: string; to: string }> = []
          for (const artifactPath of activeArtifacts) {
            const src = path.resolve(instance.directory, artifactPath)
            const srcExists = yield* fs.existsSafe(src)
            if (srcExists) {
              const dst = path.join(archiveBase, "artifacts", path.basename(src))
              yield* fs.ensureDir(path.dirname(dst))
              const content = yield* fs.readFileString(src)
              yield* fs.writeFileString(dst, content)
              archived.push({ from: src, to: dst })
            }
          }

          // Archive context
          if (ctxExists) {
            const dst = path.join(archiveBase, "current.v1.json")
            const content = yield* fs.readFileString(contextPath)
            yield* fs.writeFileString(dst, content)
            archived.push({ from: contextPath, to: dst })
          }

          const result = {
            status: "session_complete",
            report_path: reportPath,
            artifacts_archived: archived.length,
            waves_completed: Object.keys(waves).length,
            findings_consumed: activeFindings.length,
            session_summary: params.session_summary.slice(0, 500),
            next_steps: params.next_steps ?? null,
          }

          return {
            title: "generate_report",
            metadata: {
              report_path: reportPath,
              waves_completed: Object.keys(waves).length,
            },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as GenerateReport from "./generate-report"
