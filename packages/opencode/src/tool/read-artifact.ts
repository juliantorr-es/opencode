import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./read-artifact.txt"

const Parameters = Schema.Struct({
  artifact: Schema.String.annotate({
    description: "Path to the artifact (relative to workspace)",
  }),
  fields: Schema.optional(Schema.String).annotate({
    description: "Comma-separated fields to extract. Omit for full digest.",
  }),
  filter: Schema.optional(Schema.String).annotate({
    description: "Simple filter: 'severity=BLOCKING' or 'kind=delegation'",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max records to return from JSONL (default 10)",
  }),
  summary_only: Schema.optional(Schema.Boolean).annotate({
    description: "Return only a 5-line executive summary, not full data",
  }),
  profile: Schema.optional(Schema.String).annotate({
    description:
      "Filter artifacts by relevance profile (e.g. 'safety', 'memory', 'execution'). Only returns artifacts tagged with this profile or 'all'.",
  }),
})

/** Keys considered "essential" for a condensed JSONL record digest. */
const ESSENTIAL_KEYS = new Set([
  "status",
  "severity",
  "kind",
  "subject",
  "message_id",
  "recipient",
  "sender",
  "sent_at",
  "recorded_at",
  "tool_name",
  "issue",
  "plan_id",
  "boundary",
  "checkpoint_sha",
  "verdict",
  "finding",
  "occurrences",
])

export const ReadArtifactTool = Tool.define(
  "read_artifact",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const artifactPath = path.resolve(instance.directory, params.artifact)
          const limit = params.limit ?? 10
          const summaryOnly = params.summary_only ?? false
          const profileFilter = params.profile ?? null

          // Check existence
          const exists = yield* fs.existsSafe(artifactPath)
          if (!exists) {
            return {
              title: "read_artifact",
              metadata: { status: "not_found" },
              output: JSON.stringify(
                {
                  status: "not_found",
                  path: artifactPath,
                  hint: "Check artifact path — glob docs/json/opencode/**/*.json to discover available artifacts",
                },
                null,
                2,
              ),
            }
          }

          const isJsonl = /\.(jsonl|ndjson|jsonlines)$/i.test(artifactPath)

          if (isJsonl) {
            // ── JSONL processing ──
            const content = yield* fs.readFileString(artifactPath)
            const lines = content.trim().split("\n").filter(Boolean)
            const records: Array<Record<string, unknown>> = []

            for (const line of lines) {
              try {
                records.push(JSON.parse(line))
              } catch {
                // skip malformed lines
              }
            }

            let filtered = records
            const total = filtered.length

            // Apply key=value filter
            if (params.filter) {
              const eqIdx = params.filter.indexOf("=")
              if (eqIdx >= 0) {
                const filterKey = params.filter.slice(0, eqIdx)
                const filterVal = params.filter.slice(eqIdx + 1)
                filtered = filtered.filter(
                  (r) => String(r[filterKey] ?? "") === filterVal,
                )
              }
            }

            // Apply profile filter
            if (profileFilter && profileFilter !== "orchestration") {
              filtered = filtered.filter((r) => {
                const profiles = (r.relevance_profiles as string[]) ?? (r.profiles as string[]) ?? ["all"]
                return profiles.includes(profileFilter) || profiles.includes("all")
              })
            }

            // Apply limit (last N)
            const selected = filtered.slice(-limit)

            // Count by category
            const categories: Record<string, number> = {}
            for (const r of selected) {
              const cat =
                (r.kind as string) ??
                (r.severity as string) ??
                (r.category as string) ??
                (r.type as string) ??
                "entry"
              categories[cat] = (categories[cat] ?? 0) + 1
            }

            const digest: Record<string, unknown> = {
              path: artifactPath,
              type: "jsonl",
              total_records: total,
              returned: selected.length,
              filtered_by: params.filter ?? null,
              categories,
            }

            if (summaryOnly) {
              const latest = selected.length > 0 ? selected[selected.length - 1] : null
              const latestSubject =
                (latest?.subject as string) ??
                (latest?.message_id as string) ??
                ""
              digest["summary"] =
                `${total} records in ${path.basename(artifactPath)}. ` +
                `Categories: ${JSON.stringify(categories)}. ` +
                `Latest: ${latestSubject.slice(0, 80) || "none"}`
              digest["records"] = []
            } else if (params.fields) {
              const fieldList = params.fields.split(",").map((f) => f.trim())
              digest["records"] = selected.map((r) => {
                const picked: Record<string, unknown> = {}
                for (const f of fieldList) {
                  if (f in r) picked[f] = r[f]
                }
                return picked
              })
            } else {
              digest["records"] = selected.map((r) => {
                const picked: Record<string, unknown> = {}
                for (const k of ESSENTIAL_KEYS) {
                  if (k in r) picked[k] = r[k]
                }
                return picked
              })
            }

            return {
              title: "read_artifact",
              metadata: {
                type: "jsonl",
                total_records: total,
                returned: selected.length,
              },
              output: JSON.stringify(digest, null, 2),
            }
          } else {
            // ── JSON processing ──
            const data = (yield* fs.readJson(artifactPath)) as Record<string, unknown>
            let displayData = data

            // Apply field selection
            if (params.fields) {
              const fieldList = params.fields.split(",").map((f) => f.trim())
              displayData = {}
              for (const f of fieldList) {
                if (f in data) displayData[f] = data[f]
              }
            }

            const topKeys = Object.keys(displayData)
            const arrayCounts: Record<string, number> = {}
            const nestedObjects: string[] = []
            for (const [k, v] of Object.entries(displayData)) {
              if (Array.isArray(v)) arrayCounts[k] = v.length
              else if (v && typeof v === "object") nestedObjects.push(k)
            }

            const digest: Record<string, unknown> = {
              path: artifactPath,
              type: "json",
              top_level_keys: topKeys,
              array_counts: arrayCounts,
              nested_objects: nestedObjects,
            }

            if (summaryOnly) {
              digest["summary"] =
                `${path.basename(artifactPath)}: ${JSON.stringify(topKeys)}. ` +
                `Arrays: ${JSON.stringify(arrayCounts)}. ` +
                `Nested: ${JSON.stringify(nestedObjects)}.`
              digest["data"] = {}
            } else {
              // Condense: show first 3 items of arrays, collapse nested
              const condensed: Record<string, unknown> = {}
              for (const [k, v] of Object.entries(displayData)) {
                if (Array.isArray(v)) {
                  condensed[k] = v.slice(0, 3)
                  if (v.length > 3) condensed[`${k}_total`] = v.length
                } else if (v && typeof v === "object" && !Array.isArray(v)) {
                  const obj = v as Record<string, unknown>
                  const top = Object.entries(obj).slice(0, 5)
                  condensed[k] = Object.fromEntries(top)
                } else {
                  condensed[k] = v
                }
              }
              digest["data"] = condensed
            }

            return {
              title: "read_artifact",
              metadata: {
                type: "json",
                top_level_keys: topKeys.length,
              },
              output: JSON.stringify(digest, null, 2),
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ReadArtifact from "./read-artifact"
