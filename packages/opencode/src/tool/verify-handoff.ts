import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./verify-handoff.txt"

const REQUIRED_FIELDS = ["status", "files_created", "files_modified", "verification", "blockers", "deferred"]
const VALID_STATUSES = ["completed", "failed", "partial", "blocked", "frozen", "cancelled"]

const Parameters = Schema.Struct({
  handoff_json: Schema.String.annotate({ description: "The handoff JSON string to validate" }),
})

export const VerifyHandoffTool = Tool.define(
  "verify_handoff",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          let handoff: Record<string, unknown>
          try {
            handoff = JSON.parse(params.handoff_json) as Record<string, unknown>
          } catch {
            return {
              title: "verify_handoff",
              metadata: { status: "fail" },
              output: JSON.stringify({ status: "fail", errors: ["Invalid JSON — not parseable"] }, null, 2),
            }
          }

          const errors: string[] = []
          for (const field of REQUIRED_FIELDS) {
            if (!(field in handoff)) errors.push(`Missing required field: ${field}`)
          }
          if (handoff.status && typeof handoff.status === "string" && !VALID_STATUSES.includes(handoff.status)) {
            errors.push(`Invalid status '${handoff.status}'. Valid: ${VALID_STATUSES.join(", ")}`)
          }
          if (handoff.files_created && !Array.isArray(handoff.files_created)) errors.push("files_created must be an array")
          if (handoff.files_modified && !Array.isArray(handoff.files_modified)) errors.push("files_modified must be an array")
          if (handoff.verification && typeof handoff.verification !== "object") errors.push("verification must be an object")

          return {
            title: "verify_handoff",
            metadata: { status: errors.length === 0 ? "pass" : "fail" },
            output: JSON.stringify(
              {
                status: errors.length === 0 ? "pass" : "fail",
                errors,
                fields_present: REQUIRED_FIELDS.filter((f) => f in handoff),
                fields_missing: REQUIRED_FIELDS.filter((f) => !(f in handoff)),
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as VerifyHandoff from "./verify-handoff"
