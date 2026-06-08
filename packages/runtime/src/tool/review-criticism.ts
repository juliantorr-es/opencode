import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./review-criticism.txt"

const Parameters = Schema.Struct({
  plan_id: Schema.String.annotate({
    description: "Plan identifier to review",
  }),
})

export const ReviewCriticismTool = Tool.define(
  "review_criticism",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const planPath = `${instance.directory}/docs/json/opencode/plans/${params.plan_id}.v1.json`
          const commentsPath = `${instance.directory}/docs/json/opencode/plans/${params.plan_id}/comments.v1.jsonl`

          // Read plan artifact
          const planExists = yield* fs.existsSafe(planPath)
          if (!planExists) {
            throw new Error(`Plan artifact not found: ${planPath}`)
          }
          const planData = yield* fs.readJson(planPath)

          // Read comments JSONL if it exists
          const comments: Array<Record<string, unknown>> = []
          const commentsExists = yield* fs.existsSafe(commentsPath)
          if (commentsExists) {
            const content = yield* fs.readFileString(commentsPath)
            for (const line of content.trim().split("\n").filter(Boolean)) {
              try {
                comments.push(JSON.parse(line) as Record<string, unknown>)
              } catch {
                // Skip malformed lines
              }
            }
          }

          const result = {
            plan: planData,
            comments,
            comment_count: comments.length,
          }

          return {
            title: "review_criticism",
            metadata: {
              plan_id: params.plan_id,
              comment_count: comments.length,
            },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ReviewCriticism from "./review-criticism"
