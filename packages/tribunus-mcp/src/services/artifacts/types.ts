export type ArtifactType =
  | "review_source_zip_v1"
  | "review_semantic_zip_v1"
  | "review_gemini_zip_v1"
  | "source_graph_v1"
  | "code_intelligence_snapshot_v1"
  | "model_snapshot_v1"
  | "build_binary_v1"
  | "metal_air_v1"
  | "xctrace_bundle_v1"
  | "benchmark_result_v1"
  | "hardware_trace_v1"
  | "evidence_database_v1"
  | "compute_image_v1"
  | "coreml_package_v1"
  | "coreml_compiled_model_v1"
  | "generic_file_v1"

export type ArtifactState =
  | "reserved"
  | "producing"
  | "finalized"
  | "verified"
  | "verification_failed"
  | "superseded"
  | "partial"
  | "quarantined"
  | "deletion_pending"
  | "deleted"
  | "missing"

export type RetentionPolicy =
  | "permanent"
  | "mission_evidence"
  | "cache"
  | "temporary"
  | "imported_external"

export type RelationshipKind =
  | "derived_from"
  | "packaged_from"
  | "compiled_from"
  | "verified_against"
  | "supersedes"
  | "contains"
  | "extracted_from"
  | "normalized_from"
  | "compared_with"

export type DestinationMode = "exact_path" | "directory" | "content_addressed"

export type VerificationStatus = "none" | "passed" | "failed" | "stale"

export interface ArtifactRecord {
  artifact_id: string
  schema_version: number
  artifact_type: ArtifactType
  logical_name: string | null
  state: ArtifactState
  content_algorithm: string
  content_digest: string | null
  manifest_digest: string | null
  canonical_path: string
  byte_count: number | null
  file_count: number | null
  mime_type: string | null
  producer_tool: string | null
  producer_tool_version: string | null
  invocation_id: string | null
  parent_invocation_id: string | null
  session_id: string | null
  source_commit: string | null
  source_dirty: boolean | null
  normalized_argument_digest: string | null
  capability_policy_digest: string | null
  machine_profile_digest: string | null
  created_at: string
  finalized_at: string | null
  verified_at: string | null
  superseded_at: string | null
  deleted_at: string | null
  verification_status: VerificationStatus
  verification_receipt_id: string | null
  superseded_by_id: string | null
  retention_policy: RetentionPolicy
  destination_mode: DestinationMode
  provenance: "tribunus_produced" | "imported"
  metadata: Record<string, unknown> | null
}

export interface ArtifactManifest {
  schema_version: number
  artifact_root: string
  entries: ArtifactManifestEntry[]
}

export interface ArtifactManifestEntry {
  relative_path: string
  entry_type: "file" | "directory" | "symlink"
  byte_count: number
  file_digest: string | null
  symlink_target: string | null
}

export interface ArtifactRelationship {
  source_artifact_id: string
  destination_artifact_id: string
  relationship: RelationshipKind
  invocation_id: string
  metadata: Record<string, unknown> | null
  created_at: string
}

export interface VerificationReceipt {
  verification_id: string
  artifact_id: string
  artifact_type: ArtifactType
  observed_digest: string
  verifier_name: string
  status: "passed" | "failed"
  checks: Array<{ check: string; status: "pass" | "fail"; detail?: string }>
  invocation_id: string | null
  created_at: string
}

export interface ArtifactEvent {
  event_id: string
  artifact_id: string
  prior_state: ArtifactState | null
  next_state: ArtifactState
  event_type: string
  invocation_id: string | null
  reason: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export const VALID_TRANSITIONS: Record<ArtifactState, ArtifactState[]> = {
  reserved: ["producing", "partial", "deletion_pending"],
  producing: ["finalized", "partial", "deletion_pending"],
  finalized: ["verified", "verification_failed", "superseded", "quarantined", "deletion_pending", "missing"],
  verified: ["superseded", "quarantined", "deletion_pending", "verification_failed", "missing"],
  verification_failed: ["verified", "finalized", "quarantined", "deletion_pending"],
  superseded: ["deletion_pending", "missing"],
  partial: ["deletion_pending", "missing"],
  quarantined: ["finalized", "deletion_pending"],
  deletion_pending: ["deleted"],
  deleted: [],
  missing: ["finalized", "deletion_pending"],
}
