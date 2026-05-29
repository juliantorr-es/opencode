import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { ProviderID, ModelID } from "@/provider/schema"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Provider } from "@/provider/provider"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Bus } from "@/bus"
import { FetchHttpClient } from "effect/unstable/http"
import { Format } from "@/format"
import { Ripgrep } from "@/file/ripgrep"
import * as Truncate from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceState } from "@/effect/instance-state"
import { RepositoryCache } from "@/reference/repository-cache"
import { Reference } from "@/reference/reference"
import { Storage } from "@/storage/storage"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { MessageV2 } from "@/session/message-v2"

const registryLayer = ToolRegistry.layer.pipe(
  Layer.provide(
    TestConfig.layer({
      directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
    }),
  ),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Question.defaultLayer),
  Layer.provide(Todo.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Layer.mergeAll(SessionStatus.defaultLayer, BackgroundJob.defaultLayer)),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Layer.mergeAll(Git.defaultLayer, RepositoryCache.defaultLayer)),
  Layer.provide(Reference.defaultLayer),
  Layer.provide(LSP.defaultLayer),
  Layer.provide(Instruction.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Format.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(Ripgrep.defaultLayer),
  Layer.provide(Truncate.defaultLayer),
)
  .pipe(Layer.provide(Storage.defaultLayer))
  .pipe(Layer.provide(RuntimeFlags.layer({})))

const it = testEffect(Layer.mergeAll(registryLayer, Agent.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_failure_tools"),
  messageID: MessageID.make("msg_failure_tools"),
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [
    {
      info: {
        id: MessageID.make("msg_error"),
        sessionID: SessionID.make("ses_failure_tools"),
        role: "assistant",
        parentID: MessageID.make("msg_parent"),
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/", root: "/" },
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test"),
        time: { created: 0 },
      },
      parts: [
        {
          id: PartID.make("prt_error"),
          sessionID: SessionID.make("ses_failure_tools"),
          messageID: MessageID.make("msg_error"),
          type: "tool",
          callID: "call_error",
          tool: "search_replace",
          state: {
            status: "error",
            input: { find: "old", replace: "new" },
            error: "replacement failed",
            time: { start: 1, end: 2 },
          },
        },
      ] as MessageV2.Part[],
    } as MessageV2.WithParts,
  ],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool registry failure tools", () => {
  it.instance("exposes inspect_failure and report as built-in tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).toContain("inspect_failure")
      expect(ids).toContain("report")
    }),
  )

  it.instance("summarizes failed tool calls from the current message list", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")

      const tools = yield* registry.tools({
        providerID: ProviderID.opencode,
        modelID: ModelID.make("test"),
        agent: build,
      })

      const inspectFailure = tools.find((tool) => tool.id === "inspect_failure")
      if (!inspectFailure) throw new Error("inspect_failure tool not found")

      const result = yield* inspectFailure.execute({}, ctx)

      expect(result.output).toContain("search_replace")
      expect(result.output).toContain("replacement failed")
      expect(result.metadata.count).toBe(1)
    }),
  )
})
