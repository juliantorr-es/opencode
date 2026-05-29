import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./prepublication-blocked.txt"

const Parameters = Schema.Struct({
  candidate_packet_digest: Schema.String.annotations({
    description: "Digest of the candidate claim packet",
  }),
  candidate_boundary_identifier: Schema.String.annotations({
    description: "The boundary identifier being blocked",
  }),
  reviewer_set: Schema.String.annotations({ description: "JSON array of reviewer agent names" }),
  review_round: Schema.Number.annotations({ description: "Review round number" }),
  blocker_description: Schema.String.annotations({
    description: "Description of what is blocking publication",
  }),
  repair_path: Schema.optional(Schema.String).annotations({
    description: "Recommended repair path",
  }),
})

export const PrepublicationBlockedTool = Tool.define(
  "prepublication_blocked",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = `${instance.directory}/docs/json/opencode/approvals`
          const file = `${dir}/prepublication_blocked.v1.json`

          const reviewers = yield* Effect.try({
            try: () => JSON.parse(params.reviewer_set),
            catch: (error) => new Error(`Failed to parse reviewer_set: ${error}`),
          })

          const record = {
            schema_version: "v1",
            candidate_packet_digest: params.candidate_packet_digest,
            candidate_boundary_identifier: params.candidate_boundary_identifier,
            reviewer_set: reviewers,
            review_round: params.review_round,
            status: "blocked",
            blocker_description: params.blocker_description,
            repair_path: params.repair_path ?? null,
            session_id: ctx.sessionID,
            issued_at: new Date().toISOString(),
          }

          yield* fs.ensureDir(dir)
          yield* fs.writeFileString(file, JSON.stringify(record, null, 2) + "\n")

          const result = {
            status: "blocked",
            candidate_boundary_identifier: params.candidate_boundary_identifier,
            review_round: params.review_round,
          }

          return {
            title: "prepublication_blocked",
            metadata: {
              candidate_boundary_identifier: params.candidate_boundary_identifier,
              review_round: params.review_round,
            },
            output: JSON.stringify(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as PrepublicationBlocked from "./prepublication-blocked"
