import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Coordination } from "./coordination"

const Parameters = Schema.Struct({
  subagent_type: Schema.String.annotate({ description: "Subagent type to delegate to" }),
  prompt: Schema.String.annotate({ description: "Prompt or instructions for the subagent" }),
  description: Schema.optional(Schema.String).annotate({
    description: "Optional human-readable description of the delegation task",
  }),
  wave: Schema.optional(Schema.Number).annotate({ description: "Optional wave number for coordination tracking" }),
  wave_type: Schema.optional(Schema.String).annotate({
    description: "Optional wave type for coordination tracking (e.g. 'learning', 'execution')",
  }),
})

export const DelegateTool = Tool.define(
  "delegate",
  Effect.succeed({
    description:
      "Record a subagent delegation in the coordination ledger — creates a coordination task claim so the orchestrator can track, manage, and fan-out pending work across subagents",
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const taskId = `del_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

        yield* Coordination.claimTask(
          taskId,
          ctx.sessionID,
          params.subagent_type,
          params.description || params.prompt,
          params.wave ?? 0,
          (params.wave_type ?? "") as Coordination.WaveType | "",
        )

        const result = {
          task_id: taskId,
          subagent_type: params.subagent_type,
          session_id: ctx.sessionID,
          status: "claimed",
        }

        return {
          title: "delegate",
          metadata: { task_id: taskId, subagent_type: params.subagent_type },
          output: JSON.stringify(result, null, 2),
        }
      }).pipe(Effect.orDie),
  }),
)

export * as Delegate from "./delegate"
