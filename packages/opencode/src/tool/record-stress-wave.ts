import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./record-stress-wave.txt"

const Parameters = Schema.Struct({
  plan_id: Schema.String.annotate({
    description: "Plan identifier this stress wave targets",
  }),
  adversary: Schema.String.annotate({
    description: "Adversary agent name that conducted the stress",
  }),
  attack_surface: Schema.String.annotate({
    description: "Attack surface description",
  }),
  attacks_attempted: Schema.String.annotate({
    description: "JSON array of attack descriptions attempted",
  }),
  findings: Schema.String.annotate({
    description: "JSON array of finding objects with severity, description, and repair_instruction",
  }),
  verdict: Schema.Literal(
    "survived_attack",
    "falsified_blocking",
    "unproven_material",
    "deferred_outside_boundary",
    "informational",
  ).annotate({
    description:
      "Overall verdict: survived_attack | falsified_blocking | unproven_material | deferred_outside_boundary | informational",
  }),
})

export const RecordStressWaveTool = Tool.define(
  "record_stress_wave",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = `${instance.directory}/docs/json/opencode/sessions/${ctx.sessionID}/waves`
          const file = `${dir}/stress.v1.jsonl`

          const attacksAttempted = yield* Effect.try({
            try: () => JSON.parse(params.attacks_attempted),
            catch: (error) => new Error(`Failed to parse attacks_attempted: ${error}`),
          })

          const findings = yield* Effect.try({
            try: () => JSON.parse(params.findings),
            catch: (error) => new Error(`Failed to parse findings: ${error}`),
          })

          const record = {
            schema_version: "v1",
            plan_id: params.plan_id,
            adversary: params.adversary,
            attack_surface: params.attack_surface,
            attacks_attempted: attacksAttempted,
            findings,
            verdict: params.verdict,
            session_id: ctx.sessionID,
            recorded_at: new Date().toISOString(),
          }

          yield* fs.ensureDir(dir)
          yield* fs.writeFileString(file, JSON.stringify(record) + "\n", { flag: "a" })

          const result = {
            status: "ok",
            plan_id: params.plan_id,
            adversary: params.adversary,
            verdict: params.verdict,
          }

          return {
            title: "record_stress_wave",
            metadata: {
              plan_id: params.plan_id,
              adversary: params.adversary,
              verdict: params.verdict,
            },
            output: JSON.stringify(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as RecordStressWave from "./record-stress-wave"
