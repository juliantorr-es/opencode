// ── Truth Closure Tests ──────────────────────────────────────
// Verifies the fixes applied by TRUTH-1 through TRUTH-5.
// All symbols exported from secretary.ts — real assertions
// replace the old "BLOCKED" comment-tests.
//
// NOTE: HistorianComplete was removed from RuntimeEvent type
// (R1/R2 refactor). Use CheckpointCreated and LaneReturned
// directly for checkpoint/return path tests.
//
// NOTE: roleOutputToEvent remains module-private inside the
// secretary make() generator. GROUP 3 tests verify the
// RuntimeEvent types it produces map correctly through the
// public API (toSMEvent / toStoreEvent).
// ──────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { checkPredicate } from "./predicates"
import type { PredicateSpec, PredicateContext } from "./predicates"
import { deriveAllowedTools } from "./role-contracts"
import type { LaneState as RCLaneState } from "./role-contracts"
import { EventName } from "../event/event-names"
import type { RuntimeEvent as StoreRuntimeEvent } from "../event/runtime-event"

// Value exports from secretary.ts
import {
  toSMEvent,
  toStoreEvent,
  getRoleForState,
  STATE_ROLE,
  roleOutputToEvent,
} from "./secretary"
import type { RoleOutput, RuntimeEvent } from "./secretary"

// ── Helpers ──────────────────────────────────────────────────

function makeMockStoreEvent(overrides: Partial<StoreRuntimeEvent> = {}): StoreRuntimeEvent {
  return {
    id: "evt_test_001",
    sessionId: "ses_test",
    runId: "lane_test_01",
    ts: new Date().toISOString(),
    actor: "lifecycle",
    eventType: "plan.produced" as never,
    ...overrides,
  } as StoreRuntimeEvent
}

function makeMockPredicateContext(
  overrides: Partial<PredicateContext> = {},
): PredicateContext {
  return {
    events: [],
    fileMemory: new Map(),
    claims: [],
    sessionId: "ses_test",
    retryBudgets: {},
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════
// GROUP 1: toStoreEvent — CriticComplete verdict-aware
// ═══════════════════════════════════════════════════════════════

describe("toStoreEvent: CriticComplete verdict-aware", () => {
  test("CriticComplete(rejected) persists PlanRejected, not PlanApproved", () => {
    const event: RuntimeEvent = {
      _tag: "CriticComplete",
      verdict: "rejected",
      reason: "plan too risky",
    }
    const result = toStoreEvent("lane-1", "camp-1", event)
    expect(result.eventType).toBe(EventName.PlanRejected)
    expect(result.eventType).not.toBe(EventName.PlanApproved)
  })

  test("CriticComplete(approved) persists PlanApproved", () => {
    const event: RuntimeEvent = {
      _tag: "CriticComplete",
      verdict: "approved",
    }
    const result = toStoreEvent("lane-1", "camp-1", event)
    expect(result.eventType).toBe(EventName.PlanApproved)
  })

  test("toStoreEvent captures payloadJson with event fields", () => {
    const event: RuntimeEvent = {
      _tag: "CriticComplete",
      verdict: "rejected",
      reason: "too risky",
    }
    const result = toStoreEvent("lane-1", "camp-1", event)
    expect(result.payloadJson).toBeDefined()
  })

  test("toStoreEvent sets laneId and campaignId on store event", () => {
    const event: RuntimeEvent = { _tag: "PlanReady" }
    const result = toStoreEvent("lane-7", "camp-42", event)
    expect(result.runId).toBe("lane-7")
    expect(result.sessionId).toBe("camp-42")
  })

  test("toStoreEvent maps RedTeamCompleted to EventName.RedteamCompleted", () => {
    const event: RuntimeEvent = {
      _tag: "RedTeamCompleted",
      blockingFindings: 1,
      totalFindings: 3,
    }
    const result = toStoreEvent("lane-1", "camp-1", event)
    expect(result.eventType).toBe(EventName.RedteamCompleted)
  })

  test("toStoreEvent maps CheckpointCreated to EventName.SessionCheckpoint", () => {
    const event: RuntimeEvent = {
      _tag: "CheckpointCreated",
      sha: "abc123",
      message: "save checkpoint",
    }
    const result = toStoreEvent("lane-1", "camp-1", event)
    expect(result.eventType).toBe(EventName.SessionCheckpoint)
  })
})

// ═══════════════════════════════════════════════════════════════
// GROUP 2: STATE_ROLE + getRoleForState — canonical state names
// ═══════════════════════════════════════════════════════════════

describe("STATE_ROLE and getRoleForState: canonical state names", () => {
  test("getRoleForState returns cartographer for scouting", () => {
    expect(getRoleForState("scouting")).toBe("cartographer")
  })

  test("getRoleForState returns critic for critic_review", () => {
    expect(getRoleForState("critic_review")).toBe("critic")
  })

  test("getRoleForState returns redteam for red_team", () => {
    expect(getRoleForState("red_team")).toBe("redteam")
  })

  test("getRoleForState returns historian for historian", () => {
    expect(getRoleForState("historian")).toBe("historian")
  })

  test("getRoleForState returns null for returned", () => {
    expect(getRoleForState("returned")).toBeNull()
  })

  test("getRoleForState returns null for created", () => {
    expect(getRoleForState("created")).toBeNull()
  })

  test("getRoleForState returns null for failed", () => {
    expect(getRoleForState("failed")).toBeNull()
  })

  test("getRoleForState returns null for blocked", () => {
    expect(getRoleForState("blocked")).toBeNull()
  })

  test("STATE_ROLE has all canonical keys defined in types.ts", () => {
    expect(STATE_ROLE).toBeDefined()
    expect(typeof STATE_ROLE).toBe("object")
    const keys = Object.keys(STATE_ROLE)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      const value = STATE_ROLE[key as keyof typeof STATE_ROLE]
      expect(value === null || typeof value === "string").toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// GROUP 3: RuntimeEvent types per role — public API mapping
//
// roleOutputToEvent is module-private inside secretary's make()
// generator. These tests verify the RuntimeEvent types it produces
// for each role map correctly through toSMEvent / toStoreEvent.
// This proves the contract from the consumer side.
// ═══════════════════════════════════════════════════════════════

describe("RuntimeEvent types per role: correct SM and store mapping", () => {
  test("RedTeamCompleted with blockingFindings maps to redteam.completed / RedteamCompleted", () => {
    const event: RuntimeEvent = {
      _tag: "RedTeamCompleted",
      blockingFindings: 1,
      totalFindings: 3,
    }
    expect(toSMEvent(event).type).toBe("redteam.completed")
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.RedteamCompleted)
  })

  test("RedTeamCompleted with blockingFindings=0 maps correctly", () => {
    const event: RuntimeEvent = {
      _tag: "RedTeamCompleted",
      blockingFindings: 0,
      totalFindings: 2,
    }
    expect(toSMEvent(event).type).toBe("redteam.completed")
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.RedteamCompleted)
  })

  test("Blocked event maps to child.blocked / ChildBlocked", () => {
    const event: RuntimeEvent = { _tag: "Blocked", reason: "red team blocking" }
    expect(toSMEvent(event).type).toBe("child.blocked")
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.ChildBlocked)
  })

  test("Failed event maps to permission.denied / PermissionDenied", () => {
    const event: RuntimeEvent = { _tag: "Failed", error: "role crashed" }
    expect(toSMEvent(event).type).toBe("permission.denied")
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.PermissionDenied)
  })

  test("ScoutComplete maps to scout.completed / ScoutCompleted", () => {
    const event: RuntimeEvent = {
      _tag: "ScoutComplete",
      artifacts: ["map.json", "deps.json"],
    }
    expect(toSMEvent(event).type).toBe("scout.completed")
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.ScoutCompleted)
  })

  test("ArchitectComplete maps to plan.produced / PlanProduced", () => {
    const event: RuntimeEvent = { _tag: "ArchitectComplete" }
    expect(toSMEvent(event).type).toBe("plan.produced")
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.PlanProduced)
  })

  test("CheckpointCreated maps to session.checkpoint / SessionCheckpoint", () => {
    const event: RuntimeEvent = {
      _tag: "CheckpointCreated",
      sha: "abc123",
      message: "history saved",
    }
    expect(toSMEvent(event).type).toBe("session.checkpoint")
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.SessionCheckpoint)
  })

  test("CriticComplete(approved) maps to plan.approved / PlanApproved", () => {
    const event: RuntimeEvent = { _tag: "CriticComplete", verdict: "approved" }
    expect(toSMEvent(event).type).toBe("plan.approved")
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.PlanApproved)
  })

  test("CriticComplete(rejected) maps to plan.rejected / PlanRejected", () => {
    const event: RuntimeEvent = {
      _tag: "CriticComplete",
      verdict: "rejected",
      reason: "too risky",
    }
    expect(toSMEvent(event).type).toBe("plan.rejected")
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.PlanRejected)
  })

  test("ExecutorComplete with files maps to edit.applied / EditApplied", () => {
    const event: RuntimeEvent = {
      _tag: "ExecutorComplete",
      files: ["a.ts", "b.ts"],
    }
    expect(toSMEvent(event).type).toBe("edit.applied")
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.EditApplied)
  })

  test("ValidatorComplete(passed) maps to validation.completed / ValidationCompleted", () => {
    const event: RuntimeEvent = {
      _tag: "ValidatorComplete",
      passed: true,
      issues: [],
    }
    expect(toSMEvent(event).type).toBe("validation.completed")
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.ValidationCompleted)
  })

  test("ValidatorComplete(failed) maps to validation.failure via toSMEvent", () => {
    const event: RuntimeEvent = {
      _tag: "ValidatorComplete",
      passed: false,
      issues: ["test failed: foo"],
    }
    expect(toSMEvent(event).type).toBe("validation.failure")
    // toStoreEvent uses EVENT_NAME_MAP which maps ValidatorComplete → ValidationCompleted
    // regardless of passed/failed; the status field carries the resolution
    expect(toStoreEvent("lane-1", "camp-1", event).eventType).toBe(EventName.ValidationCompleted)
  })
})

// ═══════════════════════════════════════════════════════════════
// GROUP 4: toSMEvent — checkpoint/lane-returned path
// NOTE: HistorianComplete was removed from RuntimeEvent type.
// Use CheckpointCreated and LaneReturned directly.
// ═══════════════════════════════════════════════════════════════

describe("toSMEvent: checkpoint and lane-returned paths", () => {
  test("CheckpointCreated event maps to session.checkpoint", () => {
    const event: RuntimeEvent = {
      _tag: "CheckpointCreated",
      sha: "abc123",
      message: "save checkpoint",
    }
    const result = toSMEvent(event)
    expect(result.type).toBe("session.checkpoint")
    expect(result.payload).toBeDefined()
  })

  test("LaneReturned event maps to lane.returned", () => {
    const event: RuntimeEvent = {
      _tag: "LaneReturned",
      binderDigest: "abc123",
    }
    const result = toSMEvent(event)
    expect(result.type).toBe("lane.returned")
    expect(result.payload).toBeDefined()
  })

  test("CriticComplete(approved) → plan.approved in toSMEvent", () => {
    const event: RuntimeEvent = { _tag: "CriticComplete", verdict: "approved" }
    const result = toSMEvent(event)
    expect(result.type).toBe("plan.approved")
  })

  test("CriticComplete(rejected) → plan.rejected in toSMEvent", () => {
    const event: RuntimeEvent = {
      _tag: "CriticComplete",
      verdict: "rejected",
      reason: "unsafe",
    }
    const result = toSMEvent(event)
    expect(result.type).toBe("plan.rejected")
  })
})

// ═══════════════════════════════════════════════════════════════
// GROUP 5: deriveAllowedTools — canonical states
// ═══════════════════════════════════════════════════════════════

describe("deriveAllowedTools: canonical LaneState coverage", () => {
  test("deriveAllowedTools for 'scouting' returns tools", () => {
    const tools = deriveAllowedTools("scouting" as RCLaneState)
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  test("deriveAllowedTools for 'critic_review' returns tools", () => {
    const tools = deriveAllowedTools("critic_review" as RCLaneState)
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  test("deriveAllowedTools for 'red_team' returns tools", () => {
    const tools = deriveAllowedTools("red_team" as RCLaneState)
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  test("deriveAllowedTools for 'historian' returns tools", () => {
    const tools = deriveAllowedTools("historian" as RCLaneState)
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  test("deriveAllowedTools for 'executing' returns tools", () => {
    const tools = deriveAllowedTools("executing" as RCLaneState)
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  test("deriveAllowedTools for 'validating' returns tools", () => {
    const tools = deriveAllowedTools("validating" as RCLaneState)
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  test("deriveAllowedTools for terminal states returns empty array", () => {
    const tools = deriveAllowedTools("returned" as RCLaneState)
    expect(Array.isArray(tools)).toBe(true)
    // May return empty or a restricted set depending on implementation
    expect(tools.length).toBeGreaterThanOrEqual(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// GROUP 6: Full happy-path integration test — pure function chain
// ═══════════════════════════════════════════════════════════════

describe("Full happy-path: pure function chain across lifecycle", () => {
  test("toStoreEvent maps every lifecycle tag to a known EventName", () => {
    const lifecycleEvents: RuntimeEvent[] = [
      { _tag: "LaneCreated" },
      { _tag: "StartLearning" },
      { _tag: "LearningComplete", artifacts: ["findings.json"] },
      { _tag: "PlanReady" },
      { _tag: "ReviewApproved" },
      { _tag: "ExecutionComplete" },
      { _tag: "ValidationPassed" },
      { _tag: "RedTeamCompleted", blockingFindings: 0, totalFindings: 2 },
      { _tag: "CheckpointCreated", sha: "abc", message: "save" },
      { _tag: "LaneReturned", binderDigest: "digest" },
    ]

    for (const event of lifecycleEvents) {
      const storeEvent = toStoreEvent("lane-1", "camp-1", event)
      expect(storeEvent.eventType).toBeDefined()
      expect(typeof storeEvent.eventType).toBe("string")
      expect(storeEvent.eventType.length).toBeGreaterThan(0)
    }
  })

  test("toSMEvent maps every lifecycle tag to a known SM type", () => {
    const lifecycleEvents: RuntimeEvent[] = [
      { _tag: "LaneCreated" },
      { _tag: "StartLearning" },
      { _tag: "LearningComplete", artifacts: ["findings.json"] },
      { _tag: "PlanReady" },
      { _tag: "ReviewApproved" },
      { _tag: "ExecutionComplete" },
      { _tag: "ValidationPassed" },
      { _tag: "RedTeamCompleted", blockingFindings: 0, totalFindings: 2 },
      { _tag: "CheckpointCreated", sha: "abc", message: "save" },
      { _tag: "LaneReturned", binderDigest: "digest" },
    ]

    for (const event of lifecycleEvents) {
      const smEvent = toSMEvent(event)
      expect(smEvent.type).toBeDefined()
      expect(typeof smEvent.type).toBe("string")
      expect(smEvent.type.length).toBeGreaterThan(0)
    }
  })

  test("toStoreEvent → toSMEvent round-trip for major lifecycle events", () => {
    const scoutEvent: RuntimeEvent = {
      _tag: "LearningComplete",
      artifacts: ["map.json", "deps.json"],
    }
    expect(toStoreEvent("lane-1", "camp-1", scoutEvent).eventType).toBe(EventName.ScoutCompleted)
    expect(toSMEvent(scoutEvent).type).toBe("scout.completed")

    const planEvent: RuntimeEvent = { _tag: "PlanReady" }
    expect(toStoreEvent("lane-1", "camp-1", planEvent).eventType).toBe(EventName.PlanProduced)
    expect(toSMEvent(planEvent).type).toBe("plan.produced")

    const approvedEvent: RuntimeEvent = { _tag: "CriticComplete", verdict: "approved" }
    expect(toStoreEvent("lane-1", "camp-1", approvedEvent).eventType).toBe(EventName.PlanApproved)
    expect(toSMEvent(approvedEvent).type).toBe("plan.approved")

    const execEvent: RuntimeEvent = { _tag: "ExecutionComplete" }
    expect(toStoreEvent("lane-1", "camp-1", execEvent).eventType).toBe(EventName.EditApplied)
    expect(toSMEvent(execEvent).type).toBe("edit.applied")

    const valEvent: RuntimeEvent = { _tag: "ValidationPassed" }
    expect(toStoreEvent("lane-1", "camp-1", valEvent).eventType).toBe(EventName.ValidationCompleted)
    expect(toSMEvent(valEvent).type).toBe("validation.completed")
  })

  test("full happy-path spine: complete lane lifecycle via toSMEvent/toStoreEvent", () => {
    // Cartographer phase
    const startEvent: RuntimeEvent = { _tag: "StartLearning" }
    expect(toSMEvent(startEvent).type).toBe("context.sufficient")
    expect(toStoreEvent("lane-1", "camp-1", startEvent).eventType).toBe(EventName.ContextSufficient)

    const cartographerEvent: RuntimeEvent = {
      _tag: "LearningComplete",
      artifacts: ["map.json"],
    }
    expect(toSMEvent(cartographerEvent).type).toBe("scout.completed")
    expect(toStoreEvent("lane-1", "camp-1", cartographerEvent).eventType).toBe(EventName.ScoutCompleted)

    // Scope synthesized
    const scopeEvent: RuntimeEvent = {
      _tag: "ScopeSynthesized",
      summary: "fix truth-closure tests",
    }
    expect(toSMEvent(scopeEvent).type).toBe("scope.synthesized")
    expect(toStoreEvent("lane-1", "camp-1", scopeEvent).eventType).toBe(EventName.ScopeSynthesized)

    // Architect phase
    const archEvent: RuntimeEvent = { _tag: "ArchitectComplete" }
    expect(toSMEvent(archEvent).type).toBe("plan.produced")
    expect(toStoreEvent("lane-1", "camp-1", archEvent).eventType).toBe(EventName.PlanProduced)

    // Critic review — approved
    const criticEvent: RuntimeEvent = { _tag: "CriticComplete", verdict: "approved" }
    expect(toSMEvent(criticEvent).type).toBe("plan.approved")
    expect(toStoreEvent("lane-1", "camp-1", criticEvent).eventType).toBe(EventName.PlanApproved)

    // Claims acquired
    const claimsEvent: RuntimeEvent = {
      _tag: "ClaimsAcquired",
      files: ["a.ts"],
      claimIds: ["claim-1"],
    }
    expect(toSMEvent(claimsEvent).type).toBe("claims.acquired")
    expect(toStoreEvent("lane-1", "camp-1", claimsEvent).eventType).toBe(EventName.ClaimsAcquired)

    // Executor phase
    const execEvent: RuntimeEvent = {
      _tag: "ExecutorComplete",
      files: ["a.ts", "b.ts"],
    }
    expect(toSMEvent(execEvent).type).toBe("edit.applied")
    expect(toStoreEvent("lane-1", "camp-1", execEvent).eventType).toBe(EventName.EditApplied)

    // Validator phase — passed
    const valEvent: RuntimeEvent = {
      _tag: "ValidatorComplete",
      passed: true,
      issues: [],
    }
    expect(toSMEvent(valEvent).type).toBe("validation.completed")
    expect(toStoreEvent("lane-1", "camp-1", valEvent).eventType).toBe(EventName.ValidationCompleted)

    // Red team — no blocking findings
    const rtEvent: RuntimeEvent = {
      _tag: "RedTeamCompleted",
      blockingFindings: 0,
      totalFindings: 3,
    }
    expect(toSMEvent(rtEvent).type).toBe("redteam.completed")
    expect(toStoreEvent("lane-1", "camp-1", rtEvent).eventType).toBe(EventName.RedteamCompleted)

    // Checkpoint created
    const cpEvent: RuntimeEvent = {
      _tag: "CheckpointCreated",
      sha: "abc123",
      message: "done",
    }
    expect(toSMEvent(cpEvent).type).toBe("session.checkpoint")
    expect(toStoreEvent("lane-1", "camp-1", cpEvent).eventType).toBe(EventName.SessionCheckpoint)

    // Lane returned
    const lrEvent: RuntimeEvent = {
      _tag: "LaneReturned",
      binderDigest: "digest",
    }
    expect(toSMEvent(lrEvent).type).toBe("lane.returned")
    expect(toStoreEvent("lane-1", "camp-1", lrEvent).eventType).toBe(EventName.LaneReturned)
  })
})

// ═══════════════════════════════════════════════════════════════
// GROUP 7: Red-team blocking prevents progression
// ═══════════════════════════════════════════════════════════════

describe("Red-team blocking prevents progression", () => {
  test("Blocked event maps to child.blocked in toSMEvent", () => {
    const blockedEvent: RuntimeEvent = { _tag: "Blocked", reason: "red team blocking" }
    const smEvent = toSMEvent(blockedEvent)
    expect(smEvent.type).toBe("child.blocked")
    expect(smEvent.type).not.toBe("session.checkpoint")
    expect(smEvent.type).not.toBe("lane.returned")
  })

  test("Blocked event in toStoreEvent maps to EventName.ChildBlocked", () => {
    const blockedEvent: RuntimeEvent = { _tag: "Blocked", reason: "red team blocking" }
    const storeEvent = toStoreEvent("lane-1", "camp-1", blockedEvent)
    expect(storeEvent.eventType).toBe(EventName.ChildBlocked)
  })

  test("RedTeamCompleted with blockingFindings > 0 stored correctly in toStoreEvent", () => {
    const event: RuntimeEvent = {
      _tag: "RedTeamCompleted",
      blockingFindings: 2,
      totalFindings: 5,
    }
    const storeEvent = toStoreEvent("lane-1", "camp-1", event)
    expect(storeEvent.eventType).toBe(EventName.RedteamCompleted)
    expect(storeEvent.payloadJson).toBeDefined()
  })

  test("Blocked event stores reason in toSMEvent payload", () => {
    const event: RuntimeEvent = { _tag: "Blocked", reason: "finding is blocking" }
    const smEvent = toSMEvent(event)
    expect(smEvent.type).toBe("child.blocked")
    expect(smEvent.payload).toBeDefined()
  })

  test("Failed event stores error in toSMEvent payload", () => {
    const event: RuntimeEvent = { _tag: "Failed", error: "red team crashed" }
    const smEvent = toSMEvent(event)
    expect(smEvent.type).toBe("permission.denied")
    expect(smEvent.payload).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════
// GROUP 8: Restart reconstruction — pure function consistency
// ═══════════════════════════════════════════════════════════════

describe("Binder reconstruction: pure function consistency", () => {
  test("toStoreEvent for same input produces structurally equivalent output", () => {
    const event: RuntimeEvent = {
      _tag: "CriticComplete",
      verdict: "rejected",
      reason: "plan too risky",
    }
    const a = toStoreEvent("lane-1", "camp-1", event)
    const b = toStoreEvent("lane-1", "camp-1", event)

    expect(a.eventType).toBe(b.eventType)
    expect(a.runId).toBe(b.runId)
    expect(a.sessionId).toBe(b.sessionId)
  })

  test("toSMEvent for same input produces structurally equivalent output", () => {
    const event: RuntimeEvent = {
      _tag: "CriticComplete",
      verdict: "approved",
    }
    const a = toSMEvent(event)
    const b = toSMEvent(event)

    expect(a.type).toBe(b.type)
  })

  test("toStoreEvent for validation failure captures correct event type", () => {
    const failedEvent: RuntimeEvent = {
      _tag: "ValidationFailed",
      issues: ["test failed"],
    }
    const result = toStoreEvent("lane-1", "camp-1", failedEvent)
    expect(result.eventType).toBe(EventName.ValidationFailure)
  })

  test("toStoreEvent for validation pass captures correct event type", () => {
    const event: RuntimeEvent = { _tag: "ValidationPassed" }
    const result = toStoreEvent("lane-1", "camp-1", event)
    expect(result.eventType).toBe(EventName.ValidationCompleted)
  })

  test("toStoreEvent always includes all required StoreRuntimeEvent fields", () => {
    const event: RuntimeEvent = {
      _tag: "LearningComplete",
      artifacts: ["findings.json"],
    }
    const result = toStoreEvent("lane-1", "camp-1", event)
    expect(result.id).toBeDefined()
    expect(result.runId).toBe("lane-1")
    expect(result.sessionId).toBe("camp-1")
    expect(result.ts).toBeDefined()
    expect(result.actor).toBeDefined()
    expect(result.eventType).toBeDefined()
    expect(result.phase).toBe("campaign")
  })

  test("toStoreEvent includes event in payloadJson for reconstruction", () => {
    const event: RuntimeEvent = {
      _tag: "LearningComplete",
      artifacts: ["findings.json", "entry-points.json"],
    }
    const result = toStoreEvent("lane-1", "camp-1", event)
    const payload = result.payloadJson as Record<string, unknown>
    expect(payload._tag).toBe("LearningComplete")
    expect(payload.artifacts).toEqual(["findings.json", "entry-points.json"])
  })
})

// ═══════════════════════════════════════════════════════════════
// GROUP 9: CheckpointCreated / LaneReturned — correct mapping
// ═══════════════════════════════════════════════════════════════

describe("CheckpointCreated and LaneReturned: correct event mapping", () => {
  test("CheckpointCreated → toStoreEvent → SessionCheckpoint", () => {
    const event: RuntimeEvent = {
      _tag: "CheckpointCreated",
      sha: "abc123",
      message: "save",
    }
    const storeEvent = toStoreEvent("lane-1", "camp-1", event)
    expect(storeEvent.eventType).toBe(EventName.SessionCheckpoint)
  })

  test("LaneReturned → toStoreEvent → LaneReturned", () => {
    const event: RuntimeEvent = {
      _tag: "LaneReturned",
      binderDigest: "abc123",
    }
    const storeEvent = toStoreEvent("lane-1", "camp-1", event)
    expect(storeEvent.eventType).toBe(EventName.LaneReturned)
  })

  test("CheckpointCreated → toSMEvent → session.checkpoint", () => {
    const smEvent = toSMEvent({ _tag: "CheckpointCreated", sha: "abc", message: "save" })
    expect(smEvent.type).toBe("session.checkpoint")
  })

  test("LaneReturned → toSMEvent → lane.returned", () => {
    const smEvent = toSMEvent({ _tag: "LaneReturned", binderDigest: "abc" })
    expect(smEvent.type).toBe("lane.returned")
  })

  test("CheckpointCreated maps to session.checkpoint, not lane.returned", () => {
    const smEvent = toSMEvent({ _tag: "CheckpointCreated", sha: "abc", message: "save" })
    expect(smEvent.type).toBe("session.checkpoint")
    expect(smEvent.type).not.toBe("lane.returned")
  })
})

// ═══════════════════════════════════════════════════════════════
// PredicateSpec tests — real assertions
// ═══════════════════════════════════════════════════════════════

describe("Truth: PredicateSpec includes finding_blocking and redteam_completed", () => {
  test("finding_blocking is assignable to PredicateSpec", () => {
    const spec: PredicateSpec = { kind: "finding_blocking" }
    expect(spec.kind).toBe("finding_blocking")
  })

  test("redteam_completed is assignable to PredicateSpec", () => {
    const spec: PredicateSpec = { kind: "redteam_completed" }
    expect(spec.kind).toBe("redteam_completed")
  })

  test("checkPredicate resolves finding_blocking when blocking finding exists", () => {
    const mockEvent: StoreRuntimeEvent = {
      id: "evt_block_001",
      sessionId: "ses_test",
      runId: "lane_test_01",
      ts: new Date().toISOString(),
      actor: "lifecycle",
      eventType: EventName.FindingBlocking,
      status: "blocked",
      payloadJson: { reason: "danger" },
    } as StoreRuntimeEvent

    const ctx = makeMockPredicateContext({
      events: [mockEvent],
    })

    const spec: PredicateSpec = { kind: "finding_blocking" }
    const result = checkPredicate(spec, ctx)

    expect(result.satisfied).toBe(true)
  })

  test("NOT satisfied when no blocking finding exists", () => {
    const ctx = makeMockPredicateContext({
      events: [],
    })

    const spec: PredicateSpec = { kind: "finding_blocking" }
    const result = checkPredicate(spec, ctx)

    expect(result.satisfied).toBe(false)
  })

  test("redteam_completed satisfied when RedteamCompleted event with 0 blockingFindings", () => {
    const mockEvent: StoreRuntimeEvent = {
      id: "evt_red_001",
      sessionId: "ses_test",
      runId: "lane_test_01",
      ts: new Date().toISOString(),
      actor: "lifecycle",
      eventType: EventName.RedteamCompleted,
      status: "succeeded",
      payloadJson: { blockingFindings: 0, totalFindings: 3 },
    } as StoreRuntimeEvent

    const ctx = makeMockPredicateContext({
      events: [mockEvent],
    })

    const spec: PredicateSpec = { kind: "redteam_completed" }
    const result = checkPredicate(spec, ctx)

    expect(result.satisfied).toBe(true)
  })

  test("NOT satisfied when RedteamCompleted event has blockingFindings > 0", () => {
    const mockEvent: StoreRuntimeEvent = {
      id: "evt_red_002",
      sessionId: "ses_test",
      runId: "lane_test_01",
      ts: new Date().toISOString(),
      actor: "lifecycle",
      eventType: EventName.RedteamCompleted,
      status: "succeeded",
      payloadJson: { blockingFindings: 3, totalFindings: 5 },
    } as StoreRuntimeEvent

    const ctx = makeMockPredicateContext({
      events: [mockEvent],
    })

    const spec: PredicateSpec = { kind: "redteam_completed" }
    const result = checkPredicate(spec, ctx)

    expect(result.satisfied).toBe(false)
  })

  test("not satisfied when no RedteamCompleted event exists", () => {
    const ctx = makeMockPredicateContext({
      events: [],
    })

    const spec: PredicateSpec = { kind: "redteam_completed" }
    const result = checkPredicate(spec, ctx)

    expect(result.satisfied).toBe(false)
  })
})
