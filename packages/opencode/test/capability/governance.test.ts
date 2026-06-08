import { describe, expect, test } from "bun:test"
import { Effect, Exit, Cause, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { DatabaseAdapter } from "@/storage/adapter"
import { Bus } from "../../src/bus"
import { Account } from "../../src/account/account"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { ShareNext } from "../../src/share/share-next"
import { TaskTool } from "../../src/tool/task"
import { Tool } from "../../src/tool/tool"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { provideTmpdirInstance } from "../fixture/fixture"
import { BackgroundJob } from "../../src/background/job"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import {
  CapabilityContext,
  CapabilityRefusalError,
} from "../../src/capability/metadata"

const noneClient = HttpClient.make(() => Effect.die("unexpected http call"))

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
    CrossSpawnSpawner.defaultLayer,
    DatabaseAdapter.defaultLayer,
    Bus.layer,
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    mockAgentLayer,
    Truncate.defaultLayer,
    BackgroundJob.defaultLayer,
    Config.defaultLayer,
    RuntimeFlags.defaultLayer,
  )

const run = <A, E, R>(client: HttpClient.HttpClient, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(runtime(client))) as any)

describe("ADR 015 v1.1 Live Boundary Governance", () => {
  test("session.get boundary inspection succeeds in all recovery states", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessionService = yield* Session.Service
          const statusService = yield* SessionStatus.Service

          const session = yield* sessionService.create({ title: "get-test" })

          // 1. Ready state
          yield* sessionService.get(session.id)

          // 2. rebuilding state
          yield* statusService.set(session.id, { type: "coordination_rebuilding" })
          yield* sessionService.get(session.id)

          // 3. degraded state
          yield* statusService.set(session.id, { type: "coordination_degraded" })
          yield* sessionService.get(session.id)

          // 4. refused state
          yield* statusService.set(session.id, { type: "coordination_refused" })
          yield* sessionService.get(session.id)
        })
      )
    )
  })

  test("share.create blocks side effects during unsafe recovery states and missing privileges", async () => {
    let httpCallCount = 0
    const mockClient = HttpClient.make((req) => {
      httpCallCount++
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          req,
          new Response(
            JSON.stringify({
              id: "shr_abc",
              url: "https://example.com/abc",
              secret: "sec_123",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          )
        )
      )
    })

    await run(
      mockClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessionService = yield* Session.Service
          const statusService = yield* SessionStatus.Service

          const session = yield* sessionService.create({ title: "share-test" })

          // 1. Blocks under rebuilding
          yield* statusService.set(session.id, { type: "coordination_rebuilding" })
          const rebuildingExit = yield* ShareNext.use.create(session.id).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["network"],
              approvalLevelGranted: "auto",
            }),
            Effect.exit
          )
          expect(Exit.isFailure(rebuildingExit)).toBe(true)
          if (Exit.isFailure(rebuildingExit)) {
            const err = Cause.squash(rebuildingExit.cause) as CapabilityRefusalError
            expect(err._tag).toBe("CapabilityRefusalError")
            expect(err.reason).toBe("coordination_state_blocks_side_effect")
          }

          // 2. Blocks under degraded
          yield* statusService.set(session.id, { type: "coordination_degraded" })
          const degradedExit = yield* ShareNext.use.create(session.id).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["network"],
              approvalLevelGranted: "auto",
            }),
            Effect.exit
          )
          expect(Exit.isFailure(degradedExit)).toBe(true)
          if (Exit.isFailure(degradedExit)) {
            const err = Cause.squash(degradedExit.cause) as CapabilityRefusalError
            expect(err.reason).toBe("coordination_state_blocks_side_effect")
          }

          // 3. Blocks under refused
          yield* statusService.set(session.id, { type: "coordination_refused" })
          const refusedExit = yield* ShareNext.use.create(session.id).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["network"],
              approvalLevelGranted: "auto",
            }),
            Effect.exit
          )
          expect(Exit.isFailure(refusedExit)).toBe(true)
          if (Exit.isFailure(refusedExit)) {
            const err = Cause.squash(refusedExit.cause) as CapabilityRefusalError
            expect(err.reason).toBe("coordination_state_blocks_side_effect")
          }

          // Verify no network calls were made during blocked states
          expect(httpCallCount).toBe(0)

          // 4. Blocks under ready when network privilege is missing
          yield* statusService.set(session.id, { type: "idle" }) // ready state
          const privilegeExit = yield* ShareNext.use.create(session.id).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["none"],
              approvalLevelGranted: "auto",
            }),
            Effect.exit
          )
          expect(Exit.isFailure(privilegeExit)).toBe(true)
          if (Exit.isFailure(privilegeExit)) {
            const err = Cause.squash(privilegeExit.cause) as CapabilityRefusalError
            expect(err.reason).toBe("privilege_boundary_not_granted")
          }
          expect(httpCallCount).toBe(0)

          // 5. Succeeds when ready and network privilege is granted
          const successResult = yield* ShareNext.use.create(session.id).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["network"],
              approvalLevelGranted: "auto",
            })
          )
          expect(successResult.id).toBe("shr_abc")
          expect(httpCallCount).toBe(1)
        })
      )
    )
  })

  test("tool.execute boundary enforces human approval level and recovery state blocking", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessionService = yield* Session.Service
          const statusService = yield* SessionStatus.Service

          const session = yield* sessionService.create({ title: "tool-test" })

          const taskInfo = yield* TaskTool
          const testTool = yield* taskInfo.init()

          const ctx: Tool.Context = {
            sessionID: session.id,
            messageID: "msg-1" as any,
            agent: "primary",
            abort: new AbortController().signal,
            messages: [],
            metadata() {
              return Effect.void
            },
            ask() {
              return Effect.void
            },
          }

          // 1. Refuses without human approval when coordination is healthy
          yield* statusService.set(session.id, { type: "idle" }) // ready state
          const noApprovalExit = yield* testTool.execute({ description: "test task", prompt: "do something", subagent_type: "primary" }, ctx).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["shell"],
              approvalLevelGranted: "auto",
            }),
            Effect.exit
          )
          expect(Exit.isFailure(noApprovalExit)).toBe(true)
          if (Exit.isFailure(noApprovalExit)) {
            const err = Cause.squash(noApprovalExit.cause) as CapabilityRefusalError
            expect(err._tag).toBe("CapabilityRefusalError")
            expect(err.reason).toBe("privilege_boundary_not_granted")
          }

          // 2. Refuses during blocked recovery states even with approval
          yield* statusService.set(session.id, { type: "coordination_rebuilding" })
          const rebuildingExit = yield* testTool.execute({ description: "test task", prompt: "do something", subagent_type: "primary" }, ctx).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["shell"],
              approvalLevelGranted: "human",
            }),
            Effect.exit
          )
          expect(Exit.isFailure(rebuildingExit)).toBe(true)
          if (Exit.isFailure(rebuildingExit)) {
            const err = Cause.squash(rebuildingExit.cause) as CapabilityRefusalError
            expect(err.reason).toBe("coordination_state_blocks_side_effect")
          }
        })
      )
    )
  })
})
