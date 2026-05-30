import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./delegate.txt"

const Parameters = Schema.Struct({
  subagent_type: Schema.optional(Schema.String).annotate({
    description: "Agent name to delegate to. Omit to list available agents.",
  }),
  prompt: Schema.optional(Schema.String).annotate({ description: "The task prompt for the subagent" }),
  description: Schema.optional(Schema.String).annotate({ description: "Short description" }),
  workspace: Schema.optional(Schema.String).annotate({
    description: "'share' for concurrent git-worktree isolation",
  }),
  model: Schema.optional(Schema.String).annotate({ description: "Optional model override" }),
})

const DEFAULT_AGENTS = [
  "architect", "assumption-challenger", "authority-adversary", "bisecter",
  "cartographer", "claim-adversary", "convention-scout", "convergence-checker",
  "coverage-mapper", "dependency-saboteur", "edge-case-enumerator", "error-trace-auditor",
  "evidence-adversary", "execution", "explore", "historian", "impact-assessor",
  "instrumenter", "isolator", "lane-collision-adversary", "layer-grapher",
  "memory-profiler", "module-grapher", "permissions", "plan", "plan-critic",
  "prepublication-conductor", "production-proof-adversary",
  "publication-truth-adversary", "publisher", "qa", "recovery-adversary",
  "remote-main-reviewer", "repair", "repairer", "safety-auditor",
  "scope-leak-detector", "scout", "security-adversary", "source-diver",
  "surface-mapper", "synthesizer", "test-designer", "test-engineer",
  "type-checker", "ux-designer", "validator",
]

export const DelegateTool = Tool.define(
  "delegate",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context

          // If no subagent_type, return list of available agents
          if (!params.subagent_type) {
            const list = DEFAULT_AGENTS.map((a) => `- ${a}`).join("\n")
            return {
              title: "delegate",
              metadata: { mode: "list", agent_count: DEFAULT_AGENTS.length },
              output: `Available subagents:\n${list}`,
            }
          }

          // Record delegation intent
          const coordinationDir = path.join(instance.directory, "docs", "json", "opencode", "coordination")
          const ledgerPath = path.join(coordinationDir, "delegations.v1.jsonl")
          const now = new Date().toISOString()

          const record = {
            schema_version: "v1",
            subagent_type: params.subagent_type,
            description: params.description ?? params.prompt?.slice(0, 80) ?? "",
            prompt: params.prompt ?? "",
            workspace: params.workspace ?? null,
            model: params.model ?? null,
            session_id: ctx.sessionID,
            agent: ctx.agent,
            recorded_at: now,
          }

          yield* fs.ensureDir(coordinationDir)
          yield* fs.writeFileString(ledgerPath, JSON.stringify(record) + "\n", { flag: "a" })

          return {
            title: "delegate",
            metadata: {
              status: "recorded",
              subagent_type: params.subagent_type,
            },
            output: JSON.stringify({
              status: "recorded",
              subagent_type: params.subagent_type,
              description: record.description,
              workspace: record.workspace,
              action: `Call task(subagent_type='${params.subagent_type}', description='${record.description}', prompt='...') to spawn the subagent.`,
            }, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as Delegate from "./delegate"
