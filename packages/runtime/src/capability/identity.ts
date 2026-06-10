/**
 * Authority Identity Types
 *
 * Canonical identity types for the Tribunus authority model.
 * Every action in the system is attributable to one of these identity types.
 * No subsystem uses raw strings for identity references.
 *
 * Doctrine (from authority-vocabulary.json):
 * - Principal: the root identity that initiates action
 * - Actor: an entity performing actions on behalf of a principal
 * - Delegate: a temporary, scoped, revocable transfer of authority
 * - ServiceIdentity: a non-human principal for system components
 */
import { Schema } from "effect"

// ── Principal ────────────────────────────────────────────────────────────────

/**
 * The root identity that initiates action — a human user, an organization,
 * or a system root. Every action is ultimately attributable to a principal.
 */
export const Principal = Schema.Struct({
  _tag: Schema.Literal("principal"),
  id: Schema.String,
  kind: Schema.Literals("user", "organization", "system_root"),
  displayName: Schema.String,
  handle: Schema.optional(Schema.String),
})

export type Principal = typeof Principal.Type

// ── Actor ────────────────────────────────────────────────────────────────────

/**
 * An entity that performs an action on behalf of a principal.
 * Actors include agents, tools, and automated processes.
 * An actor's authority is always a subset of its principal's authority.
 */
export const Actor = Schema.Struct({
  _tag: Schema.Literal("actor"),
  id: Schema.String,
  kind: Schema.Literals("agent", "tool", "automated_process", "human"),
  principalId: Schema.String,
  displayName: Schema.String,
  /** The capability IDs this actor currently holds */
  capabilityIds: Schema.Array(Schema.String),
})

export type Actor = typeof Actor.Type

// ── Delegate ─────────────────────────────────────────────────────────────────

/**
 * A temporary or scoped transfer of authority from a principal to an actor.
 * Delegation has an expiry, a scope, and is revocable.
 * Delegation chains are traceable through the delegationChain field.
 */
export const Delegate = Schema.Struct({
  _tag: Schema.Literal("delegate"),
  id: Schema.String,
  /** The principal that granted this delegation */
  grantorId: Schema.String,
  /** The actor receiving the delegation */
  granteeId: Schema.String,
  /** The capabilities being delegated */
  capabilityIds: Schema.Array(Schema.String),
  /** When this delegation expires (Unix ms). null = permanent until revoked */
  expiresAt: Schema.Union(Schema.Number, Schema.Null),
  /** The scope within which this delegation is valid */
  scope: Schema.String,
  /** The delegation chain: [rootPrincipal, ...intermediateDelegates, thisDelegate] */
  delegationChain: Schema.Array(Schema.String),
  /** Receipt ID for the delegation grant */
  receiptId: Schema.String,
  createdAt: Schema.Number,
})

export type Delegate = typeof Delegate.Type

// ── Service Identity ─────────────────────────────────────────────────────────

/**
 * A non-human principal representing a system component or external service.
 * Service identities have capability grants like principals but no interactive
 * authentication. They authenticate via signed tokens or internal service keys.
 */
export const ServiceIdentity = Schema.Struct({
  _tag: Schema.Literal("service_identity"),
  id: Schema.String,
  kind: Schema.Literals("internal_service", "external_service", "sidecar", "plugin"),
  displayName: Schema.String,
  /** The service's public key for signature verification */
  publicKey: Schema.optional(Schema.String),
  /** The capabilities granted to this service */
  capabilityIds: Schema.Array(Schema.String),
  registeredAt: Schema.Number,
})

export type ServiceIdentity = typeof ServiceIdentity.Type

// ── Union Type ───────────────────────────────────────────────────────────────

/**
 * Any identity reference in the Tribunus authority model.
 * All subsystems use this union type, never raw strings.
 */
export const AuthorityIdentity = Schema.Union(
  Principal,
  Actor,
  Delegate,
  ServiceIdentity,
)

export type AuthorityIdentity = typeof AuthorityIdentity.Type

// ── Identity Resolution ──────────────────────────────────────────────────────

/**
 * Resolve any authority identity to its concrete type.
 * Used by the PDP to determine what capabilities are available.
 */
export function resolveIdentity(identity: AuthorityIdentity): {
  kind: "principal" | "actor" | "delegate" | "service_identity"
  capabilityIds: string[]
  isDelegated: boolean
  rootPrincipalId: string
} {
  switch (identity._tag) {
    case "principal":
      return {
        kind: "principal",
        capabilityIds: [], // Principals don't hold capabilities directly — they grant them
        isDelegated: false,
        rootPrincipalId: identity.id,
      }
    case "actor":
      return {
        kind: "actor",
        capabilityIds: identity.capabilityIds,
        isDelegated: false,
        rootPrincipalId: identity.principalId,
      }
    case "delegate":
      return {
        kind: "delegate",
        capabilityIds: identity.capabilityIds,
        isDelegated: true,
        rootPrincipalId: identity.delegationChain[0] ?? identity.grantorId,
      }
    case "service_identity":
      return {
        kind: "service_identity",
        capabilityIds: identity.capabilityIds,
        isDelegated: false,
        rootPrincipalId: identity.id,
      }
  }
}
