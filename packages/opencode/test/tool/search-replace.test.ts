import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
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
import { SessionID, MessageID } from "@/session/schema"
import { Tool } from "@/tool/tool"

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
  sessionID: SessionID.make("ses_search_replace"),
  messageID: MessageID.make("msg_search_replace"),
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool registry search replace", () => {
  it.instance("exposes search_replace as a built-in tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).toContain("search_replace")
    }),
  )

  it.instance("replaces literal text in the provided files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const first = path.join(test.directory, "first.txt")
      const second = path.join(test.directory, "nested", "second.txt")
      yield* Effect.promise(() => Bun.write(first, "foo one\n"))
      yield* Effect.promise(() => Bun.write(second, "foo two\n"))

      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")

      const tools = yield* registry.tools({
        providerID: ProviderID.opencode,
        modelID: ModelID.make("test"),
        agent: build,
      })

      const tool = tools.find((item) => item.id === "search_replace")
      if (!tool) throw new Error("search_replace tool not found")

      const result = yield* tool.execute(
        {
          find: "foo",
          replace: "bar",
          filePaths: [first, second],
        },
        ctx,
      )

      expect(result.output).toContain("first.txt")
      expect(result.output).toContain("second.txt")
      expect(yield* Effect.promise(() => Bun.file(first).text())).toContain("bar one")
      expect(yield* Effect.promise(() => Bun.file(second).text())).toContain("bar two")
    }),
  )
})
