import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./record-execution-wave.txt"

const Parameters = Schema.Struct({
  plan_id: Schema.String.annotate({
    description: "Plan identifier this execution wave targets",
  }),
  executor: Schema.String.annotate({
    description: "Executor agent name",
  }),
  changed_files: Schema.String.annotate({
    description: "JSON array of changed file paths",
  }),
  tests_run: Schema.optional(Schema.String).annotate({
    description: "JSON array of test commands executed",
  }),
  validation_passed: Schema.Boolean.annotate({
    description: "Whether pre-handoff validation passed",
  }),
  boundary_verified: Schema.Boolean.annotate({
    description: "Whether the boundary was verified against claim atoms",
  }),
  notes: Schema.optional(Schema.String).annotate({
    description: "Additional execution notes",
  }),
})

export const RecordExecutionWaveTool = Tool.define(
  "record_execution_wave",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = `${instance.directory}/docs/json/opencode/sessions/${ctx.sessionID}/waves`
          const file = `${dir}/execution.v1.jsonl`

          const changedFiles = yield* Effect.try({
            try: () => JSON.parse(params.changed_files),
            catch: (error) => new Error(`Failed to parse changed_files: ${error}`),
          })

          const testsRun = params.tests_run
            ? yield* Effect.try({
                try: () => JSON.parse(params.tests_run!),
                catch: (error) => new Error(`Failed to parse tests_run: ${error}`),
              })
            : []

          const record = {
            schema_version: "v1",
            plan_id: params.plan_id,
            executor: params.executor,
            changed_files: changedFiles,
            tests_run: testsRun,
            validation_passed: params.validation_passed,
            boundary_verified: params.boundary_verified,
            notes: params.notes ?? null,
            session_id: ctx.sessionID,
            recorded_at: new Date().toISOString(),
          }

          yield* fs.ensureDir(dir)
          yield* fs.appendLine(file, JSON.stringify(record))

          const result = {
            status: "ok",
            plan_id: params.plan_id,
            executor: params.executor,
          }

          return {
            title: "record_execution_wave",
            metadata: {
              plan_id: params.plan_id,
              executor: params.executor,
            },
            output: JSON.stringify(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as RecordExecutionWave from "./record-execution-wave"
