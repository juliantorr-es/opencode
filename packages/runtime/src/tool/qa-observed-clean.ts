import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./qa-observed-clean.txt"

const Parameters = Schema.Struct({
  plan_id: Schema.String.annotate({ description: "Plan identifier" }),
  boundary: Schema.String.annotate({ description: "Boundary name that was QA verified" }),
  tests_examined: Schema.String.annotate({ description: "JSON array of test identifiers examined" }),
  production_paths_exercised: Schema.String.annotate({
    description: "JSON array of production paths confirmed exercised",
  }),
  notes: Schema.optional(Schema.String).annotate({ description: "Additional QA notes" }),
})

export const QaObservedCleanTool = Tool.define(
  "qa_observed_clean",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const sessionDir = `${instance.directory}/docs/json/opencode/sessions/${ctx.sessionID}/qa`
          const jsonlPath = `${sessionDir}/observations.v1.jsonl`

          const tests = yield* Effect.try({
            try: () => JSON.parse(params.tests_examined),
            catch: (error) => new Error(`Failed to parse tests_examined: ${error}`),
          })

          const prodPaths = yield* Effect.try({
            try: () => JSON.parse(params.production_paths_exercised),
            catch: (error) => new Error(`Failed to parse production_paths_exercised: ${error}`),
          })

          const record = {
            schema_version: "v1",
            plan_id: params.plan_id,
            boundary: params.boundary,
            verdict: "qa_observed_clean",
            tests_examined: tests,
            production_paths_exercised: prodPaths,
            notes: params.notes ?? null,
            session_id: ctx.sessionID,
            observed_at: new Date().toISOString(),
          }

          yield* fs.ensureDir(sessionDir)
          yield* fs.appendLine(jsonlPath, JSON.stringify(record))

          const result = {
            status: "ok",
            plan_id: params.plan_id,
            boundary: params.boundary,
            verdict: "qa_observed_clean",
          }

          return {
            title: "qa_observed_clean",
            metadata: {
              plan_id: params.plan_id,
              boundary: params.boundary,
              verdict: "qa_observed_clean",
            },
            output: JSON.stringify(result),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as QaObservedClean from "./qa-observed-clean"
