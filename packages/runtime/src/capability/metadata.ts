import { Effect, Schema, Option, Context } from "effect"
import type { CoordinationRecoveryState } from "../coordination/recovery"
import { SessionStatus } from "../session/status"
import { SessionID } from "../session/schema"

export const PrivilegeBoundary = Schema.Literals([
  "none",
  "filesystem",
  "network",
  "secrets",
  "shell",
  "unknown",
])
export type PrivilegeBoundary = typeof PrivilegeBoundary.Type

export const MutationClass = Schema.Literals([
  "read-only",
  "local-mutate",
  "side-effect",
])
export type MutationClass = typeof MutationClass.Type

export const DeterminismClass = Schema.Literals([
  "deterministic",
  "non-deterministic",
  "external",
])
export type DeterminismClass = typeof DeterminismClass.Type

export const ApprovalLevel = Schema.Literals([
  "auto",
  "human",
  "senior",
])
export type ApprovalLevel = typeof ApprovalLevel.Type

export const CapabilityMetadata = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  privilegeBoundaries: Schema.Array(PrivilegeBoundary),
  mutationClass: MutationClass,
  determinismClass: DeterminismClass,
  approvalLevel: ApprovalLevel,
  blockedRecoveryStates: Schema.optional(Schema.Array(Schema.String)),
})
export type CapabilityMetadata = typeof CapabilityMetadata.Type

export type RefusalReason =
  | "coordination_state_blocks_mutation"
  | "coordination_state_blocks_side_effect"
  | "human_approval_required"
  | "senior_approval_required"
  | "privilege_boundary_not_granted"

export class CapabilityRefusalError extends Schema.TaggedErrorClass<CapabilityRefusalError>()(
  "CapabilityRefusalError",
  {
    reason: Schema.Literals([
      "coordination_state_blocks_mutation",
      "coordination_state_blocks_side_effect",
      "human_approval_required",
      "senior_approval_required",
      "privilege_boundary_not_granted",
    ]),
    message: Schema.String,
  },
) {}

// CapabilityContext to propagate permissions through fibers
export class CapabilityContext extends Context.Service<
  CapabilityContext,
  {
    readonly grantedBoundaries: readonly PrivilegeBoundary[]
    readonly approvalLevelGranted: ApprovalLevel
    readonly authorityGrants?: readonly any[]
  }
>()("@tribunus/CapabilityContext") {}

// Standard metadata definitions for live capabilities
export const sessionGetMetadata: CapabilityMetadata = {
  id: "session.get",
  description: "Retrieve details of a session",
  privilegeBoundaries: ["none"],
  mutationClass: "read-only",
  determinismClass: "deterministic",
  approvalLevel: "auto",
  blockedRecoveryStates: [],
}

export const shareCreateMetadata: CapabilityMetadata = {
  id: "share.create",
  description: "Create a share for a session",
  privilegeBoundaries: ["network"],
  mutationClass: "side-effect",
  determinismClass: "external",
  approvalLevel: "auto",
}

export const toolExecuteMetadata: CapabilityMetadata = {
  id: "tool.execute",
  description: "Execute a tool call",
  privilegeBoundaries: ["shell"],
  mutationClass: "side-effect",
  determinismClass: "external",
  approvalLevel: "human",
}

export function getFallbackRecoveryState(mutationClass: MutationClass): CoordinationRecoveryState {
  // Conservative fallback: ready is fine for read-only/non-session contexts,
  // but isolated here to allow future fail-closed policies for mutating actions.
  return "ready"
}

// Helper to query recovery state dynamically
export const getRecoveryState = (sessionID: SessionID, mutationClass: MutationClass) =>
  Effect.gen(function* () {
    const statusOpt = yield* Effect.serviceOption(SessionStatus.Service)
    if (Option.isNone(statusOpt)) {
      // In non-session context or unit tests without status layer
      return getFallbackRecoveryState(mutationClass)
    }
    const statusInfo = yield* statusOpt.value.get(sessionID)
    if (
      statusInfo.type === "coordination_rebuilding" ||
      statusInfo.type === "coordination_degraded" ||
      statusInfo.type === "coordination_refused" ||
      statusInfo.type === "coordination_unavailable" ||
      statusInfo.type === "coordination_recovered"
    ) {
      return statusInfo.type as CoordinationRecoveryState
    }
    return getFallbackRecoveryState(mutationClass)
  })

export function enforceCapabilityGovernance(options: {
  metadata: CapabilityMetadata
  recoveryState: CoordinationRecoveryState
  grantedBoundaries: readonly PrivilegeBoundary[]
  approvalLevelGranted?: ApprovalLevel
}): Effect.Effect<void, CapabilityRefusalError> {
  const { metadata, recoveryState, grantedBoundaries, approvalLevelGranted = "auto" } = options

  // 1. Check recovery state blocks
  const blockedStates = metadata.blockedRecoveryStates ?? getDefaultBlockedStates(metadata)
  if (blockedStates.includes(recoveryState)) {
    if (metadata.mutationClass === "side-effect") {
      return Effect.fail(
        new CapabilityRefusalError({
          reason: "coordination_state_blocks_side_effect",
          message: `Capability ${metadata.id} is blocked because coordination is in state: ${recoveryState}`,
        }),
      )
    }
    return Effect.fail(
      new CapabilityRefusalError({
        reason: "coordination_state_blocks_mutation",
        message: `Capability ${metadata.id} is blocked because coordination is in state: ${recoveryState}`,
      }),
    )
  }

  // 2. Privilege boundary check
  const grantedSet = new Set(grantedBoundaries)
  for (const required of metadata.privilegeBoundaries) {
    if (required !== "none" && !grantedSet.has(required)) {
      return Effect.fail(
        new CapabilityRefusalError({
          reason: "privilege_boundary_not_granted",
          message: `Required privilege boundary '${required}' not granted for capability ${metadata.id}`,
        }),
      )
    }
  }

  // 3. Approval level check
  if (metadata.approvalLevel === "human" && approvalLevelGranted === "auto") {
    return Effect.fail(
      new CapabilityRefusalError({
        reason: "human_approval_required",
        message: `Human approval required for capability ${metadata.id}`,
      }),
    )
  }

  if (metadata.approvalLevel === "senior" && approvalLevelGranted !== "senior") {
    return Effect.fail(
      new CapabilityRefusalError({
        reason: "senior_approval_required",
        message: `Senior approval required for capability ${metadata.id}`,
      }),
    )
  }

  return Effect.void
}

function getDefaultBlockedStates(metadata: CapabilityMetadata): string[] {
  const blocked: string[] = []

  // Rebuilding blocks local-mutate and side-effect
  if (metadata.mutationClass === "local-mutate" || metadata.mutationClass === "side-effect") {
    blocked.push("coordination_rebuilding")
  }

  // Degraded blocks side-effects
  if (metadata.mutationClass === "side-effect") {
    blocked.push("coordination_degraded")
  }

  // Refused blocks everything mutating
  if (metadata.mutationClass === "local-mutate" || metadata.mutationClass === "side-effect") {
    blocked.push("coordination_refused")
  }

  return blocked
}
