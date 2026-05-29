import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./curate-context.txt"

const Parameters = Schema.Struct({
  wave: Schema.String.annotate({
    description: "Current wave name — used to timestamp the update",
  }),
  key_findings: Schema.String.annotate({
    description:
      "JSON array of key findings from the completed wave, each with: {source, summary, confidence, relevance_profiles}",
  }),
  artifacts_produced: Schema.String.annotate({
    description: "JSON array of artifact paths produced by this wave",
  }),
  stale_artifacts: Schema.optional(Schema.String).annotate({
    description: "JSON array of artifact paths that are now superseded and should be archived",
  }),
  mission_status: Schema.optional(Schema.String).annotate({
    description: "Current mission status: in_progress | blocked | repairing | complete",
  }),
})

export const CurateContextTool = Tool.define(
  "curate_context",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const contextDir = `${instance.directory}/docs/json/opencode/sessions/${ctx.sessionID}/context`
          const contextPath = `${contextDir}/current.v1.json`
          const archiveBase = `${instance.directory}/docs/json/opencode/archive/${ctx.sessionID}`
          const missionStatus = params.mission_status ?? "in_progress"
          const now = new Date().toISOString()

          // Parse JSON inputs
          const findings: Array<Record<string, unknown>> = yield* Effect.try({
            try: () => JSON.parse(params.key_findings) as Array<Record<string, unknown>>,
            catch: () => [] as Array<Record<string, unknown>>,
          })

          const artifacts: string[] = yield* Effect.try({
            try: () => JSON.parse(params.artifacts_produced) as string[],
            catch: () => [] as string[],
          })

          const staleArtifacts: string[] = yield* Effect.try({
            try: () => {
              if (!params.stale_artifacts) return [] as string[]
              return JSON.parse(params.stale_artifacts!) as string[]
            },
            catch: () => [] as string[],
          })

          // Archive stale artifacts
          const archived: Array<{ from: string; to: string }> = []
          for (const artifactPath of staleArtifacts) {
            const srcPath = path.resolve(instance.directory, artifactPath)
            const exists = yield* fs.existsSafe(srcPath)
            if (exists) {
              const archiveDir = `${archiveBase}/${params.wave}`
              yield* fs.ensureDir(archiveDir)
              const fileName = path.basename(srcPath)
              const dstPath = `${archiveDir}/${fileName}`
              yield* fs.rename(srcPath, dstPath)
              archived.push({ from: srcPath, to: dstPath })
            }
          }

          // Load existing context or create new
          let context: Record<string, unknown> = {}
          const existingContext = yield* fs.readFileStringSafe(contextPath)
          if (existingContext) {
            try {
              context = JSON.parse(existingContext) as Record<string, unknown>
            } catch {
              // start fresh if corrupt
            }
          }

          // Update wave history
          const waves: Record<string, unknown> = (context.waves as Record<string, unknown>) ?? {}
          if (!waves[params.wave]) {
            waves[params.wave] = {
              started_at: now,
              completed_at: null,
              findings: [],
              artifacts: [],
            }
          }
          const waveData = waves[params.wave] as Record<string, unknown>
          waveData["completed_at"] = now
          ;(waveData["findings"] as Array<unknown>).push(...findings)
          ;(waveData["artifacts"] as Array<unknown>).push(...artifacts)

          // Build active findings list
          const activeFindings: Array<Record<string, unknown>> = []
          for (const [waveName, data] of Object.entries(waves)) {
            const wd = data as Record<string, unknown>
            for (const f of (wd["findings"] as Array<Record<string, unknown>>) ?? []) {
              f["wave"] = waveName
              activeFindings.push(f)
            }
          }

          // Collect active artifacts
          const activeArtifacts: string[] = []
          for (const data of Object.values(waves)) {
            const wd = data as Record<string, unknown>
            const arts = wd["artifacts"] as string[] | undefined
            if (arts) activeArtifacts.push(...arts)
          }

          const existingArchived = (context["archived"] as Array<Record<string, unknown>>) ?? []
          const updated: Record<string, unknown> = {
            schema_version: "v1",
            session_id: ctx.sessionID,
            mission_status: missionStatus,
            last_updated: now,
            current_wave: params.wave,
            waves,
            active_findings: activeFindings,
            active_artifacts: activeArtifacts,
            archived: [...existingArchived, ...archived],
          }

          yield* fs.ensureDir(contextDir)
          yield* fs.writeFileString(contextPath, JSON.stringify(updated, null, 2))

          const result: Record<string, unknown> = {
            status: "curated",
            wave: params.wave,
            findings_added: findings.length,
            artifacts_added: artifacts.length,
            stale_archived: archived.length,
            total_active_findings: activeFindings.length,
            context_path: contextPath,
          }

          if (archived.length > 0) {
            result["archived"] = archived
          }

          return {
            title: "curate_context",
            metadata: {
              wave: params.wave,
              findings_added: findings.length,
              artifacts_added: artifacts.length,
              stale_archived: archived.length,
            },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as CurateContext from "./curate-context"
