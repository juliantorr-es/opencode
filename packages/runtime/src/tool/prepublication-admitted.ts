import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./prepublication-admitted.txt"

const Parameters = Schema.Struct({
  candidate_packet_digest: Schema.String.annotate({
    description: "Digest of the candidate claim packet",
  }),
  candidate_boundary_identifier: Schema.String.annotate({
    description: "The boundary identifier being admitted",
  }),
  reviewer_set: Schema.String.annotate({ description: "JSON array of reviewer agent names" }),
  review_round: Schema.Number.annotate({ description: "Review round number" }),
  notes: Schema.optional(Schema.String).annotate({ description: "Additional admission notes" }),
})

export const PrepublicationAdmittedTool = Tool.define(
  "prepublication_admitted",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = `${instance.directory}/docs/json/opencode/approvals`
          const file = `${dir}/prepublication_admitted.v1.json`

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
            status: "admitted",
            notes: params.notes ?? null,
            session_id: ctx.sessionID,
            admitted_at: new Date().toISOString(),
          }

          yield* fs.ensureDir(dir)
          yield* fs.writeFileString(file, JSON.stringify(record, null, 2) + "\n")

          const result = {
            status: "admitted",
            candidate_boundary_identifier: params.candidate_boundary_identifier,
            review_round: params.review_round,
          }

          return {
            title: "prepublication_admitted",
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

export * as PrepublicationAdmitted from "./prepublication-admitted"
