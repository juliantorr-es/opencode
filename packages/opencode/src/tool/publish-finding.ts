import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { createHash } from "node:crypto"
import DESCRIPTION from "./publish-finding.txt"

const Parameters = Schema.Struct({
  finding_type: Schema.Literals(["bug", "pattern", "plan", "convention", "dependency", "risk", "optimization"]).annotate({
    description: "Type: bug | pattern | plan | convention | dependency | risk | optimization",
  }),
  summary: Schema.String.annotate({
    description: "One-sentence summary another orchestrator can evaluate in 5 seconds",
  }),
  source_artifact: Schema.String.annotate({
    description: "Path to the full artifact (session-local)",
  }),
  relevance_profiles: Schema.String.annotate({
    description: "JSON array of agent profiles this finding is relevant to",
  }),
  confidence: Schema.Number.annotate({
    description: "0-1 confidence score",
  }),
  ttl_seconds: Schema.optional(Schema.Number).annotate({
    description: "How long this finding remains relevant (default 3600 = 1 hour)",
  }),
})

export const PublishFindingTool = Tool.define(
  "publish_finding",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const registryDir = `${instance.directory}/docs/json/opencode/registry`
          const registryPath = `${registryDir}/artifacts.v1.jsonl`
          const ttl = params.ttl_seconds ?? 3600
          const now = new Date()
          const nowISO = now.toISOString()
          const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString()

          // Compute dedup key: SHA-256 of sessionId|summary
          const dedupKey = createHash("sha256")
            .update(`${ctx.sessionID}|${params.summary}`)
            .digest("hex")
            .slice(0, 16)

          // Check for existing dedup match
          const exists = yield* fs.existsSafe(registryPath)
          if (exists) {
            const content = yield* fs.readFileString(registryPath)
            const lines = content.trim().split("\n").filter(Boolean)
            for (const line of lines) {
              try {
                const existing: Record<string, unknown> = JSON.parse(line)
                if (existing.dedup_key === dedupKey) {
                  return {
                    title: "publish_finding (already published)",
                    metadata: {
                      finding_id: String(existing.finding_id ?? ""),
                      status: "already_published",
                    },
                    output: JSON.stringify(
                      {
                        status: "already_published",
                        note: "This finding is already in the registry",
                        finding_id: existing.finding_id,
                      },
                      null,
                      2,
                    ),
                  }
                }
              } catch {
                // skip malformed lines
              }
            }
          }

          // Parse relevance profiles
          const profiles = yield* Effect.try({
            try: () => JSON.parse(params.relevance_profiles) as string[],
            catch: () => [] as string[],
          })

          // Build record
          const findingId = `${String(ctx.sessionID).slice(0, 8)}-${nowISO.slice(0, 10)}-${params.finding_type}`
          const record = {
            schema_version: "v1",
            finding_id: findingId,
            dedup_key: dedupKey,
            session_id: ctx.sessionID,
            finding_type: params.finding_type,
            summary: params.summary,
            source_artifact: params.source_artifact,
            relevance_profiles: profiles,
            confidence: params.confidence,
            ttl_seconds: ttl,
            published_at: nowISO,
            expires_at: expiresAt,
          }

          yield* fs.ensureDir(registryDir)
          yield* fs.appendLine(registryPath, JSON.stringify(record))

          return {
            title: "publish_finding",
            metadata: { finding_id: findingId, status: "published" },
            output: JSON.stringify(
              {
                status: "published",
                finding_id: findingId,
                expires_at: expiresAt,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as PublishFinding from "./publish-finding"
