import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { DatabaseAdapter } from "@/storage/adapter"
import { Bus } from "../../src/bus"
import { Account } from "../../src/account/account"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { ShareNext } from "../../src/share/share-next"
import { Tool } from "../../src/tool/tool"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { provideTmpdirInstance } from "../fixture/fixture"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import {
  CapabilityContext,
  CapabilityRefusalError,
} from "../../src/capability/metadata"
import {
  CapabilityToolRegistry,
  liveRegistryLayer,
  normalizeMcpToolDefinition,
} from "../../src/capability/tool-registry"
import { queryAuthorityReceipts } from "../../src/capability/receipts"

const noneClient = HttpClient.make(() => Effect.die("unexpected http call"))

const childProcessSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
)

const mockAgentLayer = Layer.mock(Agent.Service, {
  get: () =>
    Effect.succeed({
      name: "primary",
      permission: [],
    } as any),
  list: () => Effect.succeed([]),
  defaultInfo: () => Effect.succeed({ name: "primary", permission: [] } as any),
  defaultAgent: () => Effect.succeed("primary"),
  generate: () =>
    Effect.succeed({
      identifier: "test",
      whenToUse: "test",
      systemPrompt: "test",
    }),
})

const runtime = (client: HttpClient.HttpClient) =>
  Layer.mergeAll(
    ShareNext.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Account.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    DatabaseAdapter.defaultLayer,
    Bus.layer,
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    mockAgentLayer,
    Truncate.defaultLayer,
    Config.defaultLayer,
    RuntimeFlags.defaultLayer,
    liveRegistryLayer, // Instance-scoped registry layer!
  ).pipe(Layer.provideMerge(childProcessSpawnerLayer))

const run = <A, E, R>(client: HttpClient.HttpClient, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(runtime(client))) as any)

describe("ADR 015 v1.3 Unified Tool Capability Registry", () => {
  test("1. Native Read-Only Tool runs in degraded/refused recovery states", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* CapabilityToolRegistry
          const statusService = yield* SessionStatus.Service
          const sessionService = yield* Session.Service

          const session = yield* sessionService.create({ title: "native-readonly-test" })

          // Register read-only tool
          yield* registry.registerCapabilityTool({
            toolID: "native.inspect",
            capabilityID: "tool.native.inspect",
            sourceType: "native",
            providerID: "opencode.native",
            displayName: "Inspect status",
            description: "View current status",
            metadata: {
              id: "tool.native.inspect",
              description: "View current status",
              privilegeBoundaries: ["none"],
              mutationClass: "read-only",
              determinismClass: "deterministic",
              approvalLevel: "auto",
              blockedRecoveryStates: [],
            },
            receiptBehavior: "authority-receipt",
            importStatus: "trusted",
          })

          // Evaluate during degraded state
          yield* statusService.set(session.id, { type: "coordination_refused" })

          const res = yield* registry.evaluateToolCapability("native.inspect", {
            sessionID: session.id,
            recoveryState: "coordination_refused",
            grantedBoundaries: ["none"],
            approvalLevelGranted: "auto",
          })

          expect(res.available).toBe(true)
        })
      )
    )
  })

  test("2. Native Mutating Tool is blocked during coordination_rebuilding/refused", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* CapabilityToolRegistry
          const statusService = yield* SessionStatus.Service
          const sessionService = yield* Session.Service

          const session = yield* sessionService.create({ title: "native-mutating-test" })

          yield* registry.registerCapabilityTool({
            toolID: "native.write",
            capabilityID: "tool.native.write",
            sourceType: "native",
            providerID: "opencode.native",
            displayName: "Write file",
            description: "Modifies local files",
            metadata: {
              id: "tool.native.write",
              description: "Modifies local files",
              privilegeBoundaries: ["filesystem"],
              mutationClass: "local-mutate",
              determinismClass: "deterministic",
              approvalLevel: "auto",
              blockedRecoveryStates: ["coordination_rebuilding", "coordination_refused"],
            },
            receiptBehavior: "authority-receipt",
            importStatus: "trusted",
          })

          // Blocked during rebuilding even if boundaries granted
          const res = yield* registry.evaluateToolCapability("native.write", {
            sessionID: session.id,
            recoveryState: "coordination_rebuilding",
            grantedBoundaries: ["filesystem"],
            approvalLevelGranted: "auto",
          })

          expect(res.available).toBe(false)
          expect(res.reasons).toContain("coordination_state_blocks_mutation")
        })
      )
    )
  })

  test("3. MCP Tool with Metadata evaluates exactly like native equivalent", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* CapabilityToolRegistry
          const sessionService = yield* Session.Service

          const session = yield* sessionService.create({ title: "mcp-metadata-test" })

          const mcpDef = normalizeMcpToolDefinition("github-server", {
            name: "create_issue",
            description: "Creates issue",
          }, "trusted", {
            privilegeBoundaries: ["network"],
            mutationClass: "side-effect",
            determinismClass: "external",
            approvalLevel: "auto",
            blockedRecoveryStates: ["coordination_refused"],
          })

          yield* registry.registerCapabilityTool(mcpDef)

          // Allowed with network boundary
          const res1 = yield* registry.evaluateToolCapability("github-server.create_issue", {
            sessionID: session.id,
            recoveryState: "ready",
            grantedBoundaries: ["network"],
            approvalLevelGranted: "auto",
          })
          expect(res1.available).toBe(true)

          // Refused without network boundary
          const res2 = yield* registry.evaluateToolCapability("github-server.create_issue", {
            sessionID: session.id,
            recoveryState: "ready",
            grantedBoundaries: [],
            approvalLevelGranted: "auto",
          })
          expect(res2.available).toBe(false)
          expect(res2.reasons).toContain("privilege_boundary_not_granted")
        })
      )
    )
  })

  test("4. MCP Tool with Missing Metadata is conservative", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* CapabilityToolRegistry
          const sessionService = yield* Session.Service

          const session = yield* sessionService.create({ title: "mcp-missing-test" })

          const conservativeDef = normalizeMcpToolDefinition("unknown-server", {
            name: "execute_action",
            description: "Run custom action",
          }, "conservative")

          yield* registry.registerCapabilityTool(conservativeDef)

          // Blocked because of "unknown" boundary which is not granted by default
          const res1 = yield* registry.evaluateToolCapability("unknown-server.execute_action", {
            sessionID: session.id,
            recoveryState: "ready",
            grantedBoundaries: ["network", "filesystem", "shell"],
            approvalLevelGranted: "auto",
          })
          expect(res1.available).toBe(false)
          expect(res1.reasons).toContain("privilege_boundary_not_granted")

          // Requires human approval level
          const res2 = yield* registry.evaluateToolCapability("unknown-server.execute_action", {
            sessionID: session.id,
            recoveryState: "ready",
            grantedBoundaries: ["unknown"],
            approvalLevelGranted: "auto",
          })
          expect(res2.available).toBe(false)
          expect(res2.reasons).toContain("human_approval_required")

          // Allowed only with unknown boundary AND human approval level
          const res3 = yield* registry.evaluateToolCapability("unknown-server.execute_action", {
            sessionID: session.id,
            recoveryState: "ready",
            grantedBoundaries: ["unknown"],
            approvalLevelGranted: "human",
          })
          expect(res3.available).toBe(true)
        })
      )
    )
  })

  test("5. Descriptions are not policy: 'read-only' description is still conservative without metadata", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* CapabilityToolRegistry
          const sessionService = yield* Session.Service

          const session = yield* sessionService.create({ title: "mcp-desc-test" })

          const deceptiveDef = normalizeMcpToolDefinition("server-a", {
            name: "read_secrets",
            description: "This is a safe read-only tool that gets secrets.",
          }, "conservative")

          yield* registry.registerCapabilityTool(deceptiveDef)

          // Must still require "unknown" boundary and "human" approval
          const res = yield* registry.evaluateToolCapability("server-a.read_secrets", {
            sessionID: session.id,
            recoveryState: "ready",
            grantedBoundaries: [],
            approvalLevelGranted: "auto",
          })
          expect(res.available).toBe(false)
          expect(res.reasons).toContain("privilege_boundary_not_granted")
        })
      )
    )
  })

  test("6. Trusted MCP provider accepts explicit governance metadata", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* CapabilityToolRegistry
          const sessionService = yield* Session.Service

          const session = yield* sessionService.create({ title: "mcp-trusted-test" })

          const trustedDef = normalizeMcpToolDefinition(
            "trusted-server",
            {
              name: "create_issue",
              description: "Create issue",
            },
            "trusted",
            {
              privilegeBoundaries: ["network"],
              mutationClass: "side-effect",
              determinismClass: "external",
              approvalLevel: "auto",
              blockedRecoveryStates: ["coordination_refused"],
            },
          )

          yield* registry.registerCapabilityTool(trustedDef)

          const allowed = yield* registry.evaluateToolCapability("trusted-server.create_issue", {
            sessionID: session.id,
            recoveryState: "ready",
            grantedBoundaries: ["network"],
            approvalLevelGranted: "auto",
          })
          expect(allowed.available).toBe(true)
          expect(trustedDef.importStatus).toBe("trusted")
        })
      )
    )
  })

  test("7. Trusted MCP provider without metadata remains conservative", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const trustedDef = normalizeMcpToolDefinition(
            "trusted-server",
            {
              name: "list_stuff",
              description: "List stuff",
            },
            "trusted",
          )

          expect(trustedDef.importStatus).toBe("conservative")
          expect(trustedDef.metadata.privilegeBoundaries).toEqual(["unknown"])
          expect(trustedDef.metadata.approvalLevel).toBe("human")
        })
      )
    )
  })

  test("8. Registry Isolation: Tool registered in one test/runtime does not leak", async () => {
    // Register tool in Runtime 1
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* CapabilityToolRegistry
          yield* registry.registerCapabilityTool({
            toolID: "native.isolated",
            capabilityID: "tool.native.isolated",
            sourceType: "native",
            providerID: "opencode.native",
            displayName: "Isolated Tool",
            description: "Isolated Tool Description",
            metadata: {
              id: "tool.native.isolated",
              description: "Isolated Tool",
              privilegeBoundaries: ["none"],
              mutationClass: "read-only",
              determinismClass: "deterministic",
              approvalLevel: "auto",
            },
            receiptBehavior: "none",
            importStatus: "trusted",
          })

          const resolved = yield* registry.resolveCapabilityTool("native.isolated")
          expect(resolved).toBeDefined()

          yield* registry.resetCapabilityToolRegistry()
          const resetExit = yield* registry.resolveCapabilityTool("native.isolated").pipe(Effect.exit)
          expect(Exit.isFailure(resetExit)).toBe(true)
        })
      )
    )

    // Verify it is NOT present in Runtime 2
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* CapabilityToolRegistry
          const exit = yield* registry.resolveCapabilityTool("native.isolated").pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
        })
      )
    )
  })

  test("9. Provider-scoped replacement removes stale MCP tools", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* CapabilityToolRegistry

          const first = normalizeMcpToolDefinition(
            "provider-a",
            { name: "tool_one", description: "One" },
            "trusted",
            {
              privilegeBoundaries: ["network"],
              mutationClass: "side-effect",
              determinismClass: "external",
              approvalLevel: "auto",
            },
          )
          const second = normalizeMcpToolDefinition(
            "provider-a",
            { name: "tool_two", description: "Two" },
            "trusted",
            {
              privilegeBoundaries: ["filesystem"],
              mutationClass: "local-mutate",
              determinismClass: "deterministic",
              approvalLevel: "auto",
            },
          )

          yield* registry.replaceCapabilityToolsForProvider("provider-a", [first, second])
          expect(yield* registry.resolveCapabilityTool("provider-a.tool_one")).toBeDefined()
          expect(yield* registry.resolveCapabilityTool("provider-a.tool_two")).toBeDefined()

          const refreshed = normalizeMcpToolDefinition(
            "provider-a",
            { name: "tool_two", description: "Two" },
            "trusted",
            {
              privilegeBoundaries: ["filesystem"],
              mutationClass: "local-mutate",
              determinismClass: "deterministic",
              approvalLevel: "human",
            },
          )
          yield* registry.replaceCapabilityToolsForProvider("provider-a", [refreshed])

          const removed = yield* registry.resolveCapabilityTool("provider-a.tool_one").pipe(Effect.exit)
          expect(Exit.isFailure(removed)).toBe(true)

          const kept = yield* registry.resolveCapabilityTool("provider-a.tool_two")
          expect(kept.metadata.approvalLevel).toBe("human")

          yield* registry.removeCapabilityToolsByProvider("provider-a")
          const cleared = yield* registry.resolveCapabilityTool("provider-a.tool_two").pipe(Effect.exit)
          expect(Exit.isFailure(cleared)).toBe(true)
        })
      )
    )
  })

  test("10. Live tool.execute uses registry metadata and writes content-light receipts", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* CapabilityToolRegistry
          const sessionService = yield* Session.Service

          const session = yield* sessionService.create({ title: "live-execute-test" })

          // Register tool in registry
          yield* registry.registerCapabilityTool({
            toolID: "registry-demo",
            capabilityID: "tool.native.registry-demo",
            sourceType: "native",
            providerID: "opencode.native",
            displayName: "Registry Demo",
            description: "Run a minimal governed tool",
            metadata: {
              id: "tool.native.registry-demo",
              description: "Run a minimal governed tool",
              privilegeBoundaries: ["shell"],
              mutationClass: "side-effect",
              determinismClass: "external",
              approvalLevel: "human",
              blockedRecoveryStates: ["coordination_rebuilding"],
            },
            receiptBehavior: "authority-receipt",
            importStatus: "trusted",
          })

          const toolInfo = yield* Tool.define(
            "registry-demo",
            Effect.succeed({
              description: "Run a minimal governed tool",
              parameters: Schema.Struct({
                input: Schema.String,
              }),
              execute(params: { input: string }) {
                return Effect.succeed({
                  title: "registry-demo",
                  output: `processed:${params.input}`,
                  metadata: { truncated: false },
                })
              },
            }),
          )
          const testTool = yield* toolInfo.init()

          const ctx: Tool.Context = {
            sessionID: session.id,
            messageID: "msg-1" as any,
            agent: "primary",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          }

          // Attempt execution with proper boundaries but no human approval (Refuses)
          const refusalExit = yield* testTool.execute(
            { input: "do something" },
            ctx
          ).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["shell"],
              approvalLevelGranted: "auto",
              authorityGrants: [],
            }),
            Effect.exit
          )
          expect(Exit.isFailure(refusalExit)).toBe(true)

          const receipts = yield* queryAuthorityReceipts({ sessionId: session.id })
          expect(receipts.length).toBe(1)
          expect(receipts[0].outcome).toBe("refused")
          expect(receipts[0].capabilityID).toBe("tool.native.registry-demo")
          expect(receipts[0].reasons).toContain("missing_authority_grant")

          // Verify structured metadata fields in receipt authority chain
          const meta = receipts[0].authorityChain[0]
          expect(meta.toolID).toBe("registry-demo")
          expect(meta.providerID).toBe("opencode.native")
          expect(meta.sourceType).toBe("native")
          expect(meta.importStatus).toBe("trusted")

          // Verify no raw args are present in the authority chain/receipt
          const strChain = JSON.stringify(receipts[0].authorityChain)
          expect(strChain).not.toContain("do something")
          expect(strChain).not.toContain("processed:")
        })
      )
    )
  })

  test("11. Passive evaluation does not write receipts", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const registry = yield* CapabilityToolRegistry
          const sessionService = yield* Session.Service

          const session = yield* sessionService.create({ title: "passive-test" })

          yield* registry.registerCapabilityTool({
            toolID: "native.inspect-2",
            capabilityID: "tool.native.inspect-2",
            sourceType: "native",
            providerID: "opencode.native",
            displayName: "Inspect status",
            description: "View current status",
            metadata: {
              id: "tool.native.inspect-2",
              description: "View current status",
              privilegeBoundaries: ["none"],
              mutationClass: "read-only",
              determinismClass: "deterministic",
              approvalLevel: "auto",
              blockedRecoveryStates: [],
            },
            receiptBehavior: "authority-receipt",
            importStatus: "trusted",
          })

          // Evaluate passively
          yield* registry.evaluateToolCapability("native.inspect-2", {
            sessionID: session.id,
            recoveryState: "ready",
            grantedBoundaries: ["none"],
            approvalLevelGranted: "auto",
          })

          // Check receipts
          const receipts = yield* queryAuthorityReceipts({ sessionId: session.id })
          expect(receipts.length).toBe(0)
        })
      )
    )
  })
})
