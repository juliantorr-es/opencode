import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./comment-plan.txt"

const Parameters = Schema.Struct({
  plan_id: Schema.String.annotate({ description: "Plan identifier" }),
  comment: Schema.String.annotate({ description: "Comment text" }),
  author: Schema.optional(Schema.String).annotate({
    description: "Comment author (defaults to current agent)",
  }),
})

export const CommentPlanTool = Tool.define(
  "comment_plan",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const planPath = `${instance.directory}/docs/json/opencode/plans/${params.plan_id}.v1.json`

          const exists = yield* fs.existsSafe(planPath)
          if (!exists) {
            return {
              title: "comment_plan",
              metadata: { status: "fail" },
              output: JSON.stringify(
                { status: "fail", error: `Plan not found: ${params.plan_id}` },
                null,
                2,
              ),
            }
          }

          const content = yield* fs.readFileString(planPath)
          const plan = JSON.parse(content) as Record<string, unknown>
          if (!plan.comments) plan.comments = [] as Array<Record<string, unknown>>
          const comments = plan.comments as Array<Record<string, unknown>>
          comments.push({
            author: params.author || ctx.agent,
            comment: params.comment,
            at: new Date().toISOString(),
          })
          yield* fs.writeFileString(planPath, JSON.stringify(plan, null, 2))

          return {
            title: "comment_plan",
            metadata: { plan_id: params.plan_id, comment_count: comments.length },
            output: JSON.stringify(
              { status: "commented", plan_id: params.plan_id, comment_count: comments.length },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as CommentPlan from "./comment-plan"
