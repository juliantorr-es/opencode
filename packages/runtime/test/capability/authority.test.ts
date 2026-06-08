import { describe, expect, test } from "bun:test"
import { Effect, Exit, Cause, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@tribunus/core/cross-spawn-spawner"
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
import { evaluateCapabilityAuthority } from "../../src/capability/authority"
import { queryAuthorityReceipts, persistAuthorityReceipt } from "../../src/capability/receipts"

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

describe("ADR 015/010 v1 Capability Authority Provenance and Consent Receipts", () => {
  test("session.get returns available with runtime_default authority and no missing authority", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessionService = yield* Session.Service
          const statusService = yield* SessionStatus.Service

          const session = yield* sessionService.create({ title: "inspect-test" })

          // Ready state evaluation
          const status1 = yield* sessionService.get(session.id)
          expect(status1).toBeDefined()

          // Degraded/Refused inspection should also succeed
          yield* statusService.set(session.id, { type: "coordination_refused" })
          const status2 = yield* sessionService.get(session.id)
          expect(status2).toBeDefined()

          // Verify no receipts were persisted for passive read checks
          const receipts = (yield* queryAuthorityReceipts({ sessionId: session.id })) as any
          expect(receipts.length).toBe(0)
        })
      )
    )
  })

  test("share.create ready state returns allowed only when boundaries explained by grant", async () => {
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
            { status: 200, headers: { "content-type": "application/json" } }
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

          const session = yield* sessionService.create({ title: "share-grant-test" })
          yield* statusService.set(session.id, { type: "idle" })

          // 1. share.create without grant should fail (missing authority grant)
          const failExit = yield* ShareNext.use.create(session.id).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["network"],
              approvalLevelGranted: "auto",
              authorityGrants: [], // No grants
            }),
            Effect.exit
          )
          expect(Exit.isFailure(failExit)).toBe(true)

          const failReceipts = (yield* queryAuthorityReceipts({ sessionId: session.id })) as any
          expect(failReceipts.length).toBe(1)
          expect(failReceipts[0].outcome).toBe("refused")
          expect(failReceipts[0].reasons).toContain("missing_authority_grant")

          // 2. share.create with valid grant should succeed
          const validGrant = {
            id: "grant_123",
            source: "user_session_approval" as const,
            scope: "external_network" as const,
            capabilityId: "share.create",
            privilegeBoundaries: ["network"],
            approvalLevel: "auto",
            consentClass: "public_share_consent" as const,
            timeCreated: Date.now(),
            isEphemeral: true,
          }

          const successResult = yield* ShareNext.use.create(session.id).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["network"],
              approvalLevelGranted: "auto",
              authorityGrants: [validGrant],
            })
          )
          expect(successResult.id).toBe("shr_abc")

          const allReceipts = (yield* queryAuthorityReceipts({ sessionId: session.id })) as any
          // 1 refused receipt + 1 allowed receipt
          expect(allReceipts.length).toBe(2)
          const allowedReceipt = allReceipts.find((r: any) => r.outcome === "allowed")
          expect(allowedReceipt).toBeDefined()
          expect(allowedReceipt?.consentClass).toBe("public_share_consent")
        })
      )
    )
  })

  test("share.create during coordination_degraded/refused returns unavailable (recovery dominates)", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessionService = yield* Session.Service
          const statusService = yield* SessionStatus.Service

          const session = yield* sessionService.create({ title: "share-recovery-domination" })
          yield* statusService.set(session.id, { type: "coordination_degraded" })

          const validGrant = {
            id: "grant_123",
            source: "user_session_approval" as const,
            scope: "external_network" as const,
            capabilityId: "share.create",
            privilegeBoundaries: ["network"],
            approvalLevel: "auto",
            consentClass: "public_share_consent" as const,
            timeCreated: Date.now(),
            isEphemeral: true,
          }

          // Even with valid grant, recovery state blocks it
          const failExit = yield* ShareNext.use.create(session.id).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["network"],
              approvalLevelGranted: "auto",
              authorityGrants: [validGrant],
            }),
            Effect.exit
          )
          expect(Exit.isFailure(failExit)).toBe(true)

          const receipts = (yield* queryAuthorityReceipts({ sessionId: session.id })) as any
          expect(receipts.length).toBe(1)
          expect(receipts[0].outcome).toBe("refused")
          expect(receipts[0].reasons).toContain("coordination_state_blocks_side_effect")
        })
      )
    )
  })

  test("tool.execute enforces human approval level and recovery state blocking", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessionService = yield* Session.Service
          const statusService = yield* SessionStatus.Service

          const session = yield* sessionService.create({ title: "tool-test" })
          yield* statusService.set(session.id, { type: "idle" })

          const taskInfo = yield* TaskTool
          const testTool = yield* taskInfo.init()

          const ctx: Tool.Context = {
            sessionID: session.id,
            messageID: "msg-1" as any,
            agent: "primary",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          }

          const validGrant = {
            id: "grant_tool",
            source: "user_session_approval" as const,
            scope: "session" as const,
            capabilityId: "tool.execute",
            privilegeBoundaries: ["shell"],
            approvalLevel: "human",
            consentClass: "ephemeral_approval" as const,
            timeCreated: Date.now(),
            isEphemeral: true,
          }

          // 1. Refuses without human approval (approvalLevelGranted: auto)
          const noApprovalExit = yield* testTool.execute({ description: "test task", prompt: "do something", subagent_type: "primary" }, ctx).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["shell"],
              approvalLevelGranted: "auto",
              authorityGrants: [validGrant],
            }),
            Effect.exit
          )
          expect(Exit.isFailure(noApprovalExit)).toBe(true)

          // 2. Refuses during blocked recovery states even with approval
          yield* statusService.set(session.id, { type: "coordination_rebuilding" })
          const rebuildingExit = yield* testTool.execute({ description: "test task", prompt: "do something", subagent_type: "primary" }, ctx).pipe(
            Effect.provideService(CapabilityContext, {
              grantedBoundaries: ["shell"],
              approvalLevelGranted: "human",
              authorityGrants: [validGrant],
            }),
            Effect.exit
          )
          expect(Exit.isFailure(rebuildingExit)).toBe(true)

          const receipts = (yield* queryAuthorityReceipts({ sessionId: session.id })) as any
          expect(receipts.length).toBe(2)
          expect(receipts[0].outcome).toBe("refused")
          expect(receipts[1].outcome).toBe("refused")
        })
      )
    )
  })

  test("side-effecting capabilities are not allowed by runtime_default", () => {
    const mockMetadata = {
      id: "share.create",
      description: "Test share capability",
      privilegeBoundaries: ["network"] as any[],
      mutationClass: "side-effect" as const,
      determinismClass: "external" as const,
      approvalLevel: "auto" as const,
    }

    const defaultGrant = {
      id: "grant_default",
      source: "runtime_default" as const,
      scope: "runtime" as const,
      capabilityId: "share.create",
      privilegeBoundaries: ["network"],
      approvalLevel: "auto",
      consentClass: "none" as const,
      timeCreated: Date.now(),
      isEphemeral: true,
    }

    const res = evaluateCapabilityAuthority({
      metadata: mockMetadata,
      recoveryState: "ready",
      grantedBoundaries: ["network"],
      approvalLevelGranted: "auto",
      availableAuthorityGrants: [defaultGrant],
    })

    expect(res.available).toBe(false)
    expect(res.reasons).toContain("missing_authority_grant")
  })

  test("authority-receipts query enforces session scoping, ordering, limits, and passive invariant", async () => {
    await run(
      noneClient,
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const sessionService = yield* Session.Service

          const sessionA = yield* sessionService.create({ title: "session-a" })
          const sessionB = yield* sessionService.create({ title: "session-b" })

          // 1. Insert receipts for both sessions
          yield* persistAuthorityReceipt({
            capabilityId: "share.create",
            actionName: "ShareNext.create",
            sessionId: sessionA.id,
            authorityOutcome: "allowed",
            recoveryState: "ready",
            approvalLevel: "auto",
            privilegeBoundaries: ["network"],
            consentClass: "public_share_consent",
          })

          yield* persistAuthorityReceipt({
            capabilityId: "tool.execute",
            actionName: "Tool.execute",
            sessionId: sessionB.id,
            authorityOutcome: "refused",
            recoveryState: "ready",
            approvalLevel: "human",
            privilegeBoundaries: ["shell"],
            consentClass: "ephemeral_approval",
          })

          // 2. Query session A and assert session B's receipts never appear (Scoping)
          const receiptsA1 = yield* queryAuthorityReceipts({ sessionId: sessionA.id })
          expect(receiptsA1.length).toBe(1)
          expect(receiptsA1[0].sessionID).toBe(sessionA.id)
          expect(receiptsA1[0].capabilityID).toBe("share.create")

          const receiptsB = yield* queryAuthorityReceipts({ sessionId: sessionB.id })
          expect(receiptsB.length).toBe(1)
          expect(receiptsB[0].sessionID).toBe(sessionB.id)
          expect(receiptsB[0].capabilityID).toBe("tool.execute")

          // 3. Passive invariant: Querying receipts doesn't write anything new
          const receiptsA2 = yield* queryAuthorityReceipts({ sessionId: sessionA.id })
          expect(receiptsA2.length).toBe(1)

          // 4. Ordering and Limits: Insert multiple receipts for session A with sequential timestamps
          yield* persistAuthorityReceipt({
            capabilityId: "share.create",
            actionName: "ShareNext.create",
            sessionId: sessionA.id,
            authorityOutcome: "refused",
            refusalReasons: ["coordination_state_blocks_side_effect"],
            recoveryState: "coordination_degraded",
            approvalLevel: "auto",
            privilegeBoundaries: ["network"],
            consentClass: "none",
          })

          yield* persistAuthorityReceipt({
            capabilityId: "session.get",
            actionName: "Session.get",
            sessionId: sessionA.id,
            authorityOutcome: "allowed",
            recoveryState: "ready",
            approvalLevel: "auto",
            privilegeBoundaries: [],
            consentClass: "none",
          })

          // Query with limit 2
          const limitedA = yield* queryAuthorityReceipts({ sessionId: sessionA.id, limit: 2 })
          expect(limitedA.length).toBe(2)

          // Verify newest-first (the session.get one should be first since it was inserted last)
          expect(limitedA[0].capabilityID).toBe("session.get")
          expect(limitedA[1].capabilityID).toBe("share.create")
          expect(limitedA[1].outcome).toBe("refused")
        })
      )
    )
  })
})
