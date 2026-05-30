import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./produce-fragment.txt"

const Parameters = Schema.Struct({
  target_file: Schema.String.annotate({ description: "The shared file being edited" }),
  lane_id: Schema.String.annotate({ description: "Your lane identifier" }),
  anchor_hint: Schema.String.annotate({
    description: "Where this fragment should be applied (e.g. 'after line 232', 'before isValidMcpEntry')",
  }),
  content: Schema.String.annotate({
    description: "The fragment content to insert or the replacement text",
  }),
  dependencies: Schema.optional(Schema.String).annotate({
    description: "JSON array of lane IDs this fragment depends on",
  }),
})

export const ProduceFragmentTool = Tool.define(
  "produce_fragment",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = `${instance.directory}/docs/json/opencode/sessions/${ctx.sessionID}/fragments`
          const fragmentPath = `${dir}/${params.lane_id}.v1.json`

          let deps: string[] = []
          if (params.dependencies) {
            try {
              deps = JSON.parse(params.dependencies) as string[]
            } catch { /* ignore invalid JSON */ }
          }

          const fragment = {
            schema_version: "v1",
            target_file: params.target_file,
            lane_id: params.lane_id,
            anchor_hint: params.anchor_hint,
            content: params.content,
            dependencies: deps,
            produced_at: new Date().toISOString(),
          }

          yield* fs.ensureDir(dir)
          yield* fs.writeFileString(fragmentPath, JSON.stringify(fragment) + "\n", { flag: "a" })

          return {
            title: "produce_fragment",
            metadata: { target_file: params.target_file, lane_id: params.lane_id },
            output: JSON.stringify(
              { status: "produced", target_file: params.target_file, lane_id: params.lane_id },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ProduceFragment from "./produce-fragment"
