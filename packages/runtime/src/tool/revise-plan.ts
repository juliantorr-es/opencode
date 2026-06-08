import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./revise-plan.txt"

const Parameters = Schema.Struct({
  plan_id: Schema.String.annotate({
    description: "Existing plan identifier to revise",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Updated title",
  }),
  boundary: Schema.optional(Schema.String).annotate({
    description: "Updated boundary name",
  }),
  consumer_purpose: Schema.optional(Schema.String).annotate({
    description: "Updated consumer purpose",
  }),
  claim_atoms: Schema.optional(Schema.String).annotate({
    description: "Updated JSON array of claim atom strings",
  }),
  content: Schema.String.annotate({
    description: "Revised full plan content",
  }),
  revision_notes: Schema.String.annotate({
    description: "What changed in this revision",
  }),
})

export const RevisePlanTool = Tool.define(
  "revise_plan",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const planPath = `${instance.directory}/docs/json/opencode/plans/${params.plan_id}.v1.json`

          // Read existing plan artifact
          const exists = yield* fs.existsSafe(planPath)
          if (!exists) {
            throw new Error(`Plan artifact not found: ${planPath}`)
          }

          const artifact = (yield* fs.readJson(planPath)) as Record<string, unknown>

          // Increment revision
          artifact.plan_revision = ((artifact.plan_revision as number) ?? 1) + 1

          // Override specified fields
          if (params.title !== undefined) artifact.title = params.title
          if (params.boundary !== undefined) artifact.boundary = params.boundary
          if (params.consumer_purpose !== undefined) artifact.consumer_purpose = params.consumer_purpose
          if (params.claim_atoms !== undefined) {
            try {
              const parsed = JSON.parse(params.claim_atoms)
              if (!Array.isArray(parsed)) throw new Error("not an array")
              artifact.claim_atoms = parsed
            } catch {
              throw new Error(
                `claim_atoms is not a valid JSON array. Received: ${params.claim_atoms.slice(0, 80)}`,
              )
            }
          }

          artifact.content = params.content
          artifact.revision_notes = params.revision_notes
          artifact.modified_at = new Date().toISOString()

          // Write back
          yield* fs.writeJson(planPath, artifact)

          return {
            title: "revise_plan",
            metadata: {
              plan_id: params.plan_id,
              revision: artifact.plan_revision as number,
            },
            output: JSON.stringify(
              {
                status: "ok",
                plan_id: params.plan_id,
                revision: artifact.plan_revision,
                path: planPath,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as RevisePlan from "./revise-plan"
