import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./comment-plan.txt"

const Parameters = Schema.Struct({
  plan_id: Schema.String.annotate({
    description: "Plan identifier the criticism targets",
  }),
  plan_revision: Schema.Number.annotate({
    description: "Plan revision number this criticism targets",
  }),
  critic: Schema.String.annotate({
    description: "Name of the critic agent",
  }),
  category: Schema.Literals(["boundary", "evidence", "claim", "authority", "production", "security"]).annotate({
    description: "Category: boundary | evidence | claim | authority | production | security",
  }),
  severity: Schema.Literals(["informational", "weak", "blocking"]).annotate({
    description: "Severity: informational | weak | blocking",
  }),
  finding: Schema.String.annotate({
    description: "The specific finding",
  }),
  repair_path: Schema.String.annotate({
    description: "Concrete repair recommendation",
  }),
})

export const CommentPlanTool = Tool.define(
  "comment_plan",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const commentDir = `${instance.directory}/docs/json/opencode/plans/${params.plan_id}`
          const commentPath = `${commentDir}/comments.v1.jsonl`

          const record = {
            schema_version: "v1",
            plan_id: params.plan_id,
            plan_revision: params.plan_revision,
            critic: params.critic,
            category: params.category,
            severity: params.severity,
            finding: params.finding,
            repair_path: params.repair_path,
            commented_at: new Date().toISOString(),
          }

          yield* fs.ensureDir(commentDir)
          yield* fs.writeFileString(commentPath, JSON.stringify(record) + "\n", { flag: "a" })

          return {
            title: "comment_plan",
            metadata: {
              plan_id: params.plan_id,
              plan_revision: params.plan_revision,
              severity: params.severity,
            },
            output: JSON.stringify(
              {
                status: "ok",
                plan_id: params.plan_id,
                plan_revision: params.plan_revision,
                severity: params.severity,
                path: commentPath,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as CommentPlan from "./comment-plan"
