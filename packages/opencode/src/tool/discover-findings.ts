import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./discover-findings.txt"

const Parameters = Schema.Struct({
  profiles: Schema.String.annotate({
    description:
      "JSON array of profiles to match against (e.g. '[\"architecture\",\"execution\"]')",
  }),
  finding_type: Schema.optional(
    Schema.Literals(["bug", "pattern", "plan", "convention", "dependency", "risk", "optimization"]),
  ).annotate({
    description: "Filter by finding type: bug | pattern | plan | convention | dependency | risk | optimization",
  }),
  min_confidence: Schema.optional(Schema.Number).annotate({
    description: "Minimum confidence score (default 0.5)",
  }),
  exclude_session: Schema.optional(Schema.String).annotate({
    description: "Exclude findings from this session ID",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max findings to return (default 10)",
  }),
})

function parseTime(value: string | undefined): number {
  if (!value) return Infinity
  const ms = Date.parse(value)
  return isNaN(ms) ? Infinity : ms
}

export const DiscoverFindingsTool = Tool.define(
  "discover_findings",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const registryPath = `${instance.directory}/docs/json/opencode/registry/artifacts.v1.jsonl`
          const minConf = params.min_confidence ?? 0.5
          const limit = params.limit ?? 10
          const excludeSession = params.exclude_session ?? null
          const findingType = params.finding_type ?? null

          // Parse profiles from JSON string
          const profiles: string[] = yield* Effect.try({
            try: () => JSON.parse(params.profiles) as string[],
            catch: () => [] as string[],
          })

          const exists = yield* fs.existsSafe(registryPath)
          if (!exists) {
            return {
              title: "discover_findings",
              metadata: { count: 0, total_in_registry: 0 },
              output: JSON.stringify(
                {
                  findings: [],
                  count: 0,
                  note: "No cross-session registry exists yet",
                },
                null,
                2,
              ),
            }
          }

          // Read all entries
          const content = yield* fs.readFileString(registryPath)
          const lines = content.trim().split("\n").filter(Boolean)
          const entries: Array<Record<string, unknown>> = []
          for (const line of lines) {
            try {
              entries.push(JSON.parse(line))
            } catch {
              // skip malformed lines
            }
          }

          // Filter: matching profiles, not expired, not from excluded session,
          // above confidence threshold, type match
          const now = new Date()
          const matches: Array<Record<string, unknown>> = []
          for (const entry of entries) {
            // Check TTL / expiration
            const expiresAt = parseTime(String(entry.expires_at ?? ""))
            if (expiresAt < now.getTime()) continue

            // Exclude own session
            if (excludeSession && entry.session_id === excludeSession) continue

            // Match profiles (intersection)
            const entryProfiles = (entry.relevance_profiles as string[]) ?? []
            const profileSet = new Set(entryProfiles)
            const hasMatch = profiles.some((p: string) => profileSet.has(p))
            if (!hasMatch) continue

            // Finding type filter
            if (findingType && entry.finding_type !== findingType) continue

            // Confidence threshold
            const entryConfidence = Number(entry.confidence ?? 0)
            if (entryConfidence < minConf) continue

            matches.push(entry)
          }

          // Sort by confidence descending, apply limit
          matches.sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0))
          const selected = matches.slice(0, limit)

          // Build digest
          const findings = selected.map((m) => ({
            finding_id: m.finding_id,
            type: m.finding_type,
            summary: m.summary,
            confidence: m.confidence,
            source_session: m.session_id,
            source_artifact: m.source_artifact,
            profiles: m.relevance_profiles,
            published_at: m.published_at,
          }))

          const result: Record<string, unknown> = {
            findings,
            count: findings.length,
            total_in_registry: entries.length,
            profiles_searched: profiles,
          }

          if (findings.length === 0) {
            result.note =
              "No relevant cross-session findings discovered. Proceed with your own discovery."
          }

          return {
            title: "discover_findings",
            metadata: {
              count: findings.length,
              total_in_registry: entries.length,
            },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as DiscoverFindings from "./discover-findings"
