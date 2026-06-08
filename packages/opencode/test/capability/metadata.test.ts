import { describe, expect, test } from "bun:test"
import { Effect, Cause, Exit } from "effect"
import {
  enforceCapabilityGovernance,
  CapabilityMetadata,
  CapabilityRefusalError,
} from "../../src/capability/metadata"

const sessionGet: CapabilityMetadata = {
  id: "session.get",
  description: "Retrieve details of a session",
  privilegeBoundaries: ["none"],
  mutationClass: "read-only",
  determinismClass: "deterministic",
  approvalLevel: "auto",
}

const sessionCreate: CapabilityMetadata = {
  id: "session.create",
  description: "Create a new session",
  privilegeBoundaries: ["filesystem"],
  mutationClass: "local-mutate",
  determinismClass: "non-deterministic",
  approvalLevel: "auto",
}

const shareCreate: CapabilityMetadata = {
  id: "share.create",
  description: "Share a session online",
  privilegeBoundaries: ["network"],
  mutationClass: "side-effect",
  determinismClass: "external",
  approvalLevel: "auto",
}

const toolExecute: CapabilityMetadata = {
  id: "tool.execute",
  description: "Execute a tool call",
  privilegeBoundaries: ["shell"],
  mutationClass: "side-effect",
  determinismClass: "external",
  approvalLevel: "human",
}

describe("Capability Metadata Governance Enforcer", () => {
  test("Allows read-only, local-mutate, and side-effect under ready status when authorized", async () => {
    // session.get
    await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: sessionGet,
        recoveryState: "ready",
        grantedBoundaries: ["none"],
      }),
    )

    // session.create
    await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: sessionCreate,
        recoveryState: "ready",
        grantedBoundaries: ["filesystem"],
      }),
    )

    // share.create
    await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: shareCreate,
        recoveryState: "ready",
        grantedBoundaries: ["network"],
      }),
    )

    // tool.execute (requires human approval)
    await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: toolExecute,
        recoveryState: "ready",
        grantedBoundaries: ["shell"],
        approvalLevelGranted: "human",
      }),
    )
  })

  test("Refuses operations when missing privilege boundaries", async () => {
    // session.create missing filesystem boundary
    const exit = await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: sessionCreate,
        recoveryState: "ready",
        grantedBoundaries: ["none"],
      }).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause) as CapabilityRefusalError
      expect(err._tag).toBe("CapabilityRefusalError")
      expect(err.reason).toBe("privilege_boundary_not_granted")
    }
  })

  test("Refuses when required approval level is not met", async () => {
    // tool.execute defaults to auto approval, but requires human
    const exit = await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: toolExecute,
        recoveryState: "ready",
        grantedBoundaries: ["shell"],
        approvalLevelGranted: "auto",
      }).pipe(Effect.exit),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause) as CapabilityRefusalError
      expect(err._tag).toBe("CapabilityRefusalError")
      expect(err.reason).toBe("human_approval_required")
    }
  })

  test("coordination_rebuilding blocks local mutation and side-effects but allows read-only", async () => {
    // session.get (read-only) passes
    await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: sessionGet,
        recoveryState: "coordination_rebuilding",
        grantedBoundaries: ["none"],
      }),
    )

    // session.create (local-mutate) is blocked
    const createExit = await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: sessionCreate,
        recoveryState: "coordination_rebuilding",
        grantedBoundaries: ["filesystem"],
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(createExit)).toBe(true)
    if (Exit.isFailure(createExit)) {
      const err = Cause.squash(createExit.cause) as CapabilityRefusalError
      expect(err.reason).toBe("coordination_state_blocks_mutation")
    }

    // share.create (side-effect) is blocked
    const shareExit = await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: shareCreate,
        recoveryState: "coordination_rebuilding",
        grantedBoundaries: ["network"],
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(shareExit)).toBe(true)
    if (Exit.isFailure(shareExit)) {
      const err = Cause.squash(shareExit.cause) as CapabilityRefusalError
      expect(err.reason).toBe("coordination_state_blocks_side_effect")
    }
  })

  test("coordination_degraded blocks side effects but allows read-only and local mutation", async () => {
    // session.get (read-only) passes
    await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: sessionGet,
        recoveryState: "coordination_degraded",
        grantedBoundaries: ["none"],
      }),
    )

    // session.create (local-mutate) passes (degraded-safe for local mutation)
    await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: sessionCreate,
        recoveryState: "coordination_degraded",
        grantedBoundaries: ["filesystem"],
      }),
    )

    // share.create (side-effect) is blocked
    const shareExit = await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: shareCreate,
        recoveryState: "coordination_degraded",
        grantedBoundaries: ["network"],
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(shareExit)).toBe(true)
    if (Exit.isFailure(shareExit)) {
      const err = Cause.squash(shareExit.cause) as CapabilityRefusalError
      expect(err.reason).toBe("coordination_state_blocks_side_effect")
    }
  })

  test("coordination_refused blocks all mutations and side-effects but allows read-only", async () => {
    // session.get (read-only) passes
    await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: sessionGet,
        recoveryState: "coordination_refused",
        grantedBoundaries: ["none"],
      }),
    )

    // session.create (local-mutate) is blocked
    const createExit = await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: sessionCreate,
        recoveryState: "coordination_refused",
        grantedBoundaries: ["filesystem"],
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(createExit)).toBe(true)
    if (Exit.isFailure(createExit)) {
      const err = Cause.squash(createExit.cause) as CapabilityRefusalError
      expect(err.reason).toBe("coordination_state_blocks_mutation")
    }

    // share.create (side-effect) is blocked
    const shareExit = await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: shareCreate,
        recoveryState: "coordination_refused",
        grantedBoundaries: ["network"],
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(shareExit)).toBe(true)
    if (Exit.isFailure(shareExit)) {
      const err = Cause.squash(shareExit.cause) as CapabilityRefusalError
      expect(err.reason).toBe("coordination_state_blocks_side_effect")
    }
  })

  test("Explicit capability blockedRecoveryStates overrides enforcer defaults", async () => {
    const customGet: CapabilityMetadata = {
      ...sessionGet,
      id: "custom.get",
      blockedRecoveryStates: ["coordination_degraded"],
    }

    // Now blocked under degraded
    const degradedExit = await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: customGet,
        recoveryState: "coordination_degraded",
        grantedBoundaries: ["none"],
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(degradedExit)).toBe(true)

    // Passes under rebuilding
    await Effect.runPromise(
      enforceCapabilityGovernance({
        metadata: customGet,
        recoveryState: "coordination_rebuilding",
        grantedBoundaries: ["none"],
      }),
    )
  })
})
