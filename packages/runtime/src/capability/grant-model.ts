/**
 * Capability Grant Model
 *
 * Defines how capabilities are granted, scoped, composed, restricted,
 * attenuated, delegated, and revoked.
 *
 * Doctrine (from authority-vocabulary.json):
 * - Capability is a first-class type with scope, rights, and source
 * - Capability algebra: compose (AND), restrict (intersect), attenuate (narrow)
 * - Every grant produces a durable receipt in CapabilityAuthorityReceiptTable
 * - Delegation preserves provenance through the delegation chain
 * - Revocation invalidates all derived capabilities transitively
 */
import { Schema } from "effect"
import { Principal, Actor, Delegate, ServiceIdentity, type AuthorityIdentity } from "./identity"

// ── Capability ───────────────────────────────────────────────────────────────

/**
 * A named permission to perform a specific class of actions.
 * Capabilities are granted, not assumed.
 */
export const Capability = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  /** The scope within which this capability is valid */
  scope: Schema.String,
  /** The specific rights this capability confers */
  rights: Schema.Array(Schema.String),
  /** Where this capability originated */
  source: Schema.Literals(["grant", "delegation", "intrinsic", "break_glass"]),
  /** The grant receipt ID that backs this capability */
  grantReceiptId: Schema.String,
  /** When this capability was granted */
  grantedAt: Schema.Number,
  /** When this capability expires (null = permanent) */
  // @ts-expect-error Schema v4 Struct accepts raw schema, tsgo can't prove it
  expiresAt: Schema.Union(Schema.Number, Schema.Null),
  /** Whether this capability is currently active */
  isActive: Schema.Boolean,
})

export type Capability = typeof Capability.Type

// ── Capability Algebra ───────────────────────────────────────────────────────

/**
 * Compose two capabilities (AND).
 * The resulting capability has the union of rights, limited to the intersection
 * of scopes, and the earliest expiry.
 */
export function composeCapabilities(a: Capability, b: Capability): Capability {
  const rights = [...new Set([...a.rights, ...b.rights])]
  const expiresAt =
    a.expiresAt === null ? b.expiresAt :
    b.expiresAt === null ? a.expiresAt :
    Math.min(a.expiresAt as number, b.expiresAt as number)

  return {
    ...a,
    id: `${a.id}+${b.id}`,
    name: `${a.name} & ${b.name}`,
    description: `Composition of ${a.name} and ${b.name}`,
    scope: a.scope === b.scope ? a.scope : `${a.scope}∩${b.scope}`,
    rights,
    source: "grant",
    grantReceiptId: `${a.grantReceiptId}+${b.grantReceiptId}`,
    expiresAt,
    isActive: a.isActive && b.isActive,
  }
}

/**
 * Restrict a capability to a subset of rights (intersect).
 * The resulting capability has the intersection of rights.
 */
export function restrictCapability(cap: Capability, allowedRights: string[]): Capability {
  const rights = cap.rights.filter((r) => allowedRights.includes(r))
  return {
    ...cap,
    id: `${cap.id}:restricted`,
    name: `${cap.name} (restricted)`,
    description: `Restricted ${cap.name} to [${rights.join(", ")}]`,
    rights,
    isActive: cap.isActive && rights.length > 0,
  }
}

/**
 * Attenuate a capability (narrow).
 * The resulting capability has the same or fewer rights, with a narrower scope.
 */
export function attenuateCapability(
  cap: Capability,
  narrowedScope: string,
  narrowedRights?: string[]
): Capability {
  const rights = narrowedRights ?? cap.rights
  return {
    ...cap,
    id: `${cap.id}:attenuated`,
    name: `${cap.name} (attenuated)`,
    description: `Attenuated ${cap.name} to scope ${narrowedScope}`,
    scope: narrowedScope,
    rights,
    isActive: cap.isActive,
  }
}

// ── Grant ────────────────────────────────────────────────────────────────────

/**
 * The assignment of a capability from a grantor to a grantee.
 * Every grant produces a durable receipt in CapabilityAuthorityReceiptTable.
 */
export const CapabilityGrant = Schema.Struct({
  id: Schema.String,
  grantorId: Schema.String,
  granteeId: Schema.String,
  capabilityId: Schema.String,
  scope: Schema.String,
  rights: Schema.Array(Schema.String),
  /** When this grant expires (null = permanent until revoked) */
  expiresAt: Schema.Union([Schema.Number, Schema.Null]),
  /** Whether this grant is active */
  isActive: Schema.Boolean,
  /** The receipt ID in CapabilityAuthorityReceiptTable */
  receiptId: Schema.String,
  /** When the grant was created */
  createdAt: Schema.Number,
})

export type CapabilityGrant = typeof CapabilityGrant.Type

// ── Revocation ───────────────────────────────────────────────────────────────

/**
 * The removal of a previously granted capability or delegation.
 * Revocation is immediate, receipted, and propagates to all transitive dependents.
 */
export const Revocation = Schema.Struct({
  id: Schema.String,
  /** The grant or delegation being revoked */
  targetId: Schema.String,
  /** The identity performing the revocation */
  revokerId: Schema.String,
  /** The reason for revocation */
  reason: Schema.String,
  /** Receipt ID for the revocation */
  receiptId: Schema.String,
  /** When the revocation occurred */
  revokedAt: Schema.Number,
  /** The grant or delegation IDs that are transitively revoked */
  cascadeTargets: Schema.Array(Schema.String),
})

export type Revocation = typeof Revocation.Type

/**
 * Given a set of grants and a revocation, compute the set of grants
 * that are transitively invalidated.
 */
export function computeCascade(grants: CapabilityGrant[], revocation: Revocation): string[] {
  const invalidated = new Set<string>()

  // Direct target
  invalidated.add(revocation.targetId)

  // Transitive: grants whose grantor is the revoked grantee
  let expanded = true
  while (expanded) {
    expanded = false
    for (const grant of grants) {
      if (!invalidated.has(grant.id) && invalidated.has(grant.grantorId)) {
        invalidated.add(grant.id)
        expanded = true
      }
    }
  }

  return [...invalidated]
}
