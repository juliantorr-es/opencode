/**
 * Plugin manifest schema for @tribunus/plugin.
 *
 * Follows the tribunus.plugin.manifest.v1 spec: a declarative manifest
 * that a plugin publishes to declare identity, capabilities, permissions,
 * and trust metadata.
 *
 * @module
 */

/**
 * A single contribution point — the plugin's extension surface.
 */
export interface ContributionPoint {
  /** The contribution type: tool, ui, workflow, data, collaboration, or federation. */
  type: "tool" | "ui" | "workflow" | "data" | "collaboration" | "federation"
  /** Unique identifier for this contribution point within the plugin. */
  id: string
  /** Path to the implementation entrypoint, resolved relative to the plugin root. */
  entry: string
  /** Optional metadata bag for the hosting runtime. */
  metadata?: Record<string, unknown>
}

/**
 * A capability the plugin requests from the runtime.
 */
export interface CapabilityRequest {
  /** Canonical name of the capability (e.g. "filesystem.read", "network.connect"). */
  capability: string
  /** Human-readable justification for why the plugin needs this capability. */
  reason: string
  /** Optional list of sub-scopes within the capability. */
  scopes?: string[]
  /** Risk level assigned to this capability request. */
  riskLevel: "low" | "medium" | "high" | "critical"
}

/**
 * A resource permission the plugin declares.
 */
export interface PermissionDeclaration {
  /** The resource type (e.g. "file", "http", "process", "clipboard"). */
  resource: string
  /** Allowed actions on the resource (e.g. ["read", "write"]). */
  actions: string[]
  /** Optional glob pattern scoping the resource access. */
  scope?: string
}

/**
 * Trust and provenance metadata for the plugin.
 */
export interface TrustMetadata {
  /** Cryptographic signing key fingerprint. */
  signingKey?: string
  /** Publisher's public key fingerprint. */
  publisherKey?: string
  /** Whether the publisher has been verified by a trusted authority. */
  verifiedPublisher: boolean
  /** Content hash of the plugin bundle (e.g. SHA-256 hex). */
  contentHash?: string
  /** ISO 8601 date of the last audit. */
  lastAudit?: string
}

/**
 * Plugin publisher identity.
 */
export interface PublisherInfo {
  /** Display name of the publisher. */
  name: string
  /** Contact email. */
  email?: string
  /** Publisher website or repository URL. */
  url?: string
}

/**
 * The plugin manifest document — the root schema for tribunus.plugin.manifest.v1.
 *
 * A plugin publishes exactly one manifest that declares its identity, the
 * capabilities it needs, the contribution points it provides, and its trust
 * metadata. The governance pipeline evaluates this manifest before the plugin
 * is allowed to run.
 */
export interface PluginManifest {
  /** Schema discriminator — must be "tribunus.plugin.manifest.v1". */
  schema: "tribunus.plugin.manifest.v1"
  /** Globally unique plugin identifier (reverse-domain recommended). */
  id: string
  /** Semantic version string. */
  version: string
  /** Human-readable plugin name. */
  name: string
  /** Short description of what the plugin does. */
  description: string
  /** Publisher identity. */
  publisher: PublisherInfo
  /** Lifecycle events that activate this plugin (e.g. "onStartup", "onSessionOpen"). */
  activationEvents: string[]
  /** Contribution points this plugin provides. */
  contributionPoints: ContributionPoint[]
  /** Capabilities this plugin requests from the runtime. */
  capabilities: CapabilityRequest[]
  /** Resource permissions this plugin declares. */
  permissions: PermissionDeclaration[]
  /** Trust and audit metadata. */
  trust: TrustMetadata
}
