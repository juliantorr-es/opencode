import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./propose-plan.txt"

const PLAN_ID_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/

const Parameters = Schema.Struct({
  plan_id: Schema.optional(Schema.String).annotate({
    description: "Unique plan identifier (kebab-case). Auto-generated from boundary if omitted.",
  }),
  title: Schema.String.annotate({
    description: "Human-readable plan title",
  }),
  boundary: Schema.String.annotate({
    description: "Intended narrow boundary name",
  }),
  consumer_purpose: Schema.String.annotate({
    description: "Consumer purpose for this boundary",
  }),
  claim_atoms: Schema.String.annotate({
    description: "JSON array of claim atom strings, e.g. '[\"atom1\",\"atom2\"]'",
  }),
  content: Schema.String.annotate({
    description: "Full plan content",
  }),
  dry_run: Schema.optional(Schema.Boolean).annotate({
    description: "Validate and preview without writing",
  }),
})

function generatePlanId(boundary: string): string {
  return boundary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function parseClaimAtoms(raw: string): string[] {
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error("claim_atoms must be a JSON array")
  if (parsed.length === 0) throw new Error("claim_atoms must be a non-empty array")
  if (!parsed.every((item: unknown) => typeof item === "string")) {
    throw new Error("claim_atoms must be a JSON array of strings")
  }
  return parsed
}

export const ProposePlanTool = Tool.define(
  "propose_plan",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Validate claim_atoms is valid JSON array of strings
          let claimAtoms: string[]
          try {
            claimAtoms = parseClaimAtoms(params.claim_atoms)
          } catch (e: unknown) {
            throw new Error(
              `claim_atoms is not a valid JSON array of strings. Received: ${params.claim_atoms.slice(0, 80)}\n` +
              `Example: '["atom1", "atom2"]'`,
            )
          }

          // Auto-generate plan_id from boundary if omitted
          const planId = params.plan_id ?? generatePlanId(params.boundary)

          // Validate plan_id format: kebab-case, 3+ chars
          if (!PLAN_ID_PATTERN.test(planId) || planId.length < 3) {
            throw new Error(
              `plan_id "${planId}" is invalid. Must be kebab-case (lowercase letters, digits, hyphens), 3+ characters. ` +
              `Provide a valid plan_id explicitly or ensure boundary produces a valid kebab-case identifier.`,
            )
          }

          const instance = yield* InstanceState.context
          const planDir = `${instance.directory}/docs/json/opencode/plans`
          const planPath = `${planDir}/${planId}.v1.json`

          // Dry run: return preview without writing
          if (params.dry_run) {
            const preview = {
              status: "dry_run",
              preview: {
                plan_id: planId,
                title: params.title,
                boundary: params.boundary,
                consumer_purpose: params.consumer_purpose,
                claim_atoms: claimAtoms,
                content_preview:
                  params.content.length > 300
                    ? params.content.slice(0, 300) + "..."
                    : params.content,
                revision: 1,
              },
              note: "No file written. Remove dry_run=true to create.",
            }
            return {
              title: "propose_plan (dry run)",
              metadata: { plan_id: planId, dry_run: true },
              output: JSON.stringify(preview, null, 2),
            }
          }

          // Check for file existence conflict
          const exists = yield* fs.existsSafe(planPath)
          if (exists) {
            throw new Error(
              `Plan artifact already exists: ${planPath}\n` +
              `Use revise_plan to update the existing plan, or choose a different plan_id.`,
            )
          }

          // Create artifact
          const now = new Date().toISOString()
          const artifact = {
            schema_version: "v1",
            plan_id: planId,
            plan_revision: 1,
            title: params.title,
            boundary: params.boundary,
            consumer_purpose: params.consumer_purpose,
            claim_atoms: claimAtoms,
            content: params.content,
            status: "proposed",
            created_at: now,
            modified_at: now,
          }

          yield* fs.ensureDir(planDir)
          yield* fs.writeJson(planPath, artifact)

          return {
            title: "propose_plan",
            metadata: {
              plan_id: planId,
              revision: 1,
              claim_count: claimAtoms.length,
            },
            output: JSON.stringify(
              {
                status: "created",
                plan_id: planId,
                revision: 1,
                path: planPath,
                claim_count: claimAtoms.length,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ProposePlan from "./propose-plan"
