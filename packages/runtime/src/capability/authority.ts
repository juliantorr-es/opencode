import { Schema } from "effect"
import {
  type CapabilityMetadata,
  type PrivilegeBoundary,
  type ApprovalLevel,
  CapabilityRefusalError,
} from "./metadata"
import type { CoordinationRecoveryState } from "../coordination/recovery"

export const AuthoritySource = Schema.Literals([
  "runtime_default",
  "user_session_approval",
  "persisted_user_consent",
  "project_policy",
  "organization_policy",
  "recovery_state",
  "test_override",
])
export type AuthoritySource = typeof AuthoritySource.Type

export const AuthorityScope = Schema.Literals([
  "runtime",
  "session",
  "project",
  "workspace",
  "account",
  "external_network",
])
export type AuthorityScope = typeof AuthorityScope.Type

export const ConsentClass = Schema.Literals([
  "none",
  "ephemeral_approval",
  "persisted_consent",
  "export_consent",
  "public_share_consent",
])
export type ConsentClass = typeof ConsentClass.Type

export const AuthorityGrant = Schema.Struct({
  id: Schema.String,
  source: AuthoritySource,
  scope: AuthorityScope,
  capabilityId: Schema.String, // capability ID or family prefix
  privilegeBoundaries: Schema.Array(Schema.String),
  approvalLevel: Schema.String,
  consentClass: ConsentClass,
  subjectId: Schema.optional(Schema.String),
  timeCreated: Schema.Number,
  timeExpires: Schema.optional(Schema.Number),
  isEphemeral: Schema.Boolean,
})
export type AuthorityGrant = typeof AuthorityGrant.Type

export interface CapabilityAuthorityResult {
  capabilityID: string
  available: boolean
  recoveryState: CoordinationRecoveryState
  reasons: string[]
  message?: string
  authorityChain?: AuthorityGrant[]
  missingAuthority?: string[]
  effectiveApproval?: string
  requiredApproval: string
  grantedBoundaries: string[]
  requiredBoundaries: string[]
  consentClass: string
}

export function isTestEnv(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.BUN_ENV === "test" ||
    process.env.OPENCODE_TEST === "true" ||
    typeof (globalThis as any).describe === "function" // Bun/Jest globals
  )
}

export function evaluateCapabilityAuthority(options: {
  metadata: CapabilityMetadata
  recoveryState: CoordinationRecoveryState
  grantedBoundaries: readonly PrivilegeBoundary[]
  approvalLevelGranted?: ApprovalLevel
  availableAuthorityGrants?: readonly AuthorityGrant[]
}): CapabilityAuthorityResult {
  const {
    metadata,
    recoveryState,
    grantedBoundaries,
    approvalLevelGranted = "auto",
    availableAuthorityGrants,
  } = options

  let grants = availableAuthorityGrants
  if (grants === undefined) {
    if (isTestEnv()) {
      grants = [
        {
          id: `synth_legacy_test_${metadata.id}`,
          source: "test_override" as const,
          scope: "session" as const,
          capabilityId: metadata.id,
          privilegeBoundaries: [...grantedBoundaries],
          approvalLevel: approvalLevelGranted,
          consentClass: "none" as const,
          timeCreated: Date.now(),
          isEphemeral: true,
        }
      ]
    } else {
      grants = []
    }
  }

  const requiredBoundaries = metadata.privilegeBoundaries

  // Base result structure
  const result: CapabilityAuthorityResult = {
    capabilityID: metadata.id,
    available: false,
    recoveryState,
    reasons: [],
    requiredApproval: metadata.approvalLevel,
    grantedBoundaries: [...grantedBoundaries],
    requiredBoundaries: [...requiredBoundaries],
    consentClass: "none",
  }

  // 1. Check recovery state blocks (Recovery state dominates everything)
  const blockedStates = metadata.blockedRecoveryStates ?? getDefaultBlockedStates(metadata)
  if (blockedStates.includes(recoveryState)) {
    const reason =
      metadata.mutationClass === "side-effect"
        ? "coordination_state_blocks_side_effect"
        : "coordination_state_blocks_mutation"
    result.available = false
    result.reasons = [reason]
    result.missingAuthority = ["recovery_state_override"]
    result.message = `Capability ${metadata.id} is blocked because coordination is in state: ${recoveryState}`
    return result
  }

  // 2. Filter available authority grants
  const validGrants = grants.filter((grant) => {
    // Check capability match (exact or prefix, e.g. "tool.execute" prefix for "tool.execute:tool_name")
    const match =
      grant.capabilityId === metadata.id ||
      (metadata.id.startsWith(grant.capabilityId) && grant.capabilityId.length > 0)
    if (!match) return false

    // Expiration check
    if (grant.timeExpires !== undefined && grant.timeExpires <= Date.now()) {
      return false
    }

    // Safety checks on sources
    if (grant.source === "runtime_default") {
      // runtime_default can ONLY grant authority for read-only capabilities
      if (metadata.mutationClass !== "read-only") {
        return false
      }
    }

    if (grant.source === "test_override") {
      // Gate test_override strictly to test environments
      if (!isTestEnv()) {
        return false
      }
    }

    return true
  })

  // Determine if we have a valid grant that covers boundaries and approval
  // First check if any grant exists at all (unless it's read-only and we implicitly have runtime_default)
  let matchingGrant = validGrants[0]

  // If read-only and no explicit grant, we can synthesize a runtime_default grant
  if (!matchingGrant && metadata.mutationClass === "read-only") {
    matchingGrant = {
      id: `synth_default_${metadata.id}`,
      source: "runtime_default",
      scope: "runtime",
      capabilityId: metadata.id,
      privilegeBoundaries: ["none"],
      approvalLevel: "auto",
      consentClass: "none",
      timeCreated: Date.now(),
      isEphemeral: true,
    }
  }

  if (!matchingGrant) {
    result.available = false
    result.reasons = ["missing_authority_grant"]
    result.missingAuthority = [
      metadata.mutationClass === "side-effect"
        ? "user_session_approval"
        : "persisted_user_consent",
    ]
    result.message = `No valid authority grant found for capability ${metadata.id}`
    return result
  }

  result.consentClass = matchingGrant.consentClass
  result.authorityChain = [matchingGrant]

  // 3. Privilege boundary check
  const grantedSet = new Set(grantedBoundaries)
  const missingBoundaries = requiredBoundaries.filter(
    (required) => required !== "none" && !grantedSet.has(required),
  )

  if (missingBoundaries.length > 0) {
    result.available = false
    result.reasons = ["privilege_boundary_not_granted"]
    result.missingAuthority = missingBoundaries.map((b) => `boundary:${b}`)
    result.message = `Required privilege boundary '${missingBoundaries[0]}' not granted for capability ${metadata.id}`
    return result
  }

  // Also verify that the grant itself covers the required boundaries
  const grantBoundariesSet = new Set(matchingGrant.privilegeBoundaries)
  const grantMissingBoundaries = requiredBoundaries.filter(
    (required) => required !== "none" && !grantBoundariesSet.has(required),
  )
  if (grantMissingBoundaries.length > 0) {
    result.available = false
    result.reasons = ["privilege_boundary_not_granted"]
    result.missingAuthority = grantMissingBoundaries.map((b) => `grant_boundary:${b}`)
    result.message = `Authority grant does not cover required privilege boundary '${grantMissingBoundaries[0]}' for capability ${metadata.id}`
    return result
  }

  // 4. Approval level check
  if (metadata.approvalLevel === "human" && approvalLevelGranted === "auto") {
    result.available = false
    result.reasons = ["human_approval_required"]
    result.missingAuthority = ["user_session_approval"]
    result.message = `Human approval required for capability ${metadata.id}`
    return result
  }

  if (metadata.approvalLevel === "senior" && approvalLevelGranted !== "senior") {
    result.available = false
    result.reasons = ["senior_approval_required"]
    result.missingAuthority = ["senior_session_approval"]
    result.message = `Senior approval required for capability ${metadata.id}`
    return result
  }

  // Also check the grant's approval level satisfies the metadata's required approval level
  if (metadata.approvalLevel === "human" && matchingGrant.approvalLevel === "auto") {
    result.available = false
    result.reasons = ["human_approval_required"]
    result.missingAuthority = ["user_session_approval"]
    result.message = `Authority grant approval level insufficient for capability ${metadata.id}`
    return result
  }
  if (metadata.approvalLevel === "senior" && matchingGrant.approvalLevel !== "senior") {
    result.available = false
    result.reasons = ["senior_approval_required"]
    result.missingAuthority = ["senior_session_approval"]
    result.message = `Authority grant approval level insufficient for capability ${metadata.id}`
    return result
  }

  // Everything matches and is authorized!
  result.available = true
  result.effectiveApproval = approvalLevelGranted
  return result
}

function getDefaultBlockedStates(metadata: CapabilityMetadata): string[] {
  const blocked: string[] = []
  if (metadata.mutationClass === "local-mutate" || metadata.mutationClass === "side-effect") {
    blocked.push("coordination_rebuilding")
  }
  if (metadata.mutationClass === "side-effect") {
    blocked.push("coordination_degraded")
  }
  if (metadata.mutationClass === "local-mutate" || metadata.mutationClass === "side-effect") {
    blocked.push("coordination_refused")
  }
  return blocked
}
