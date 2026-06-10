export type PublicationState =
  | "planned"
  | "built"
  | "validated"
  | "staged"
  | "remote_verified"
  | "approved"
  | "published"
  | "superseded"
  | "retracted"
  | "failed"

export type EvidenceGrade =
  | "exploratory"
  | "synthetically_verified"
  | "hardware_qualified"
  | "claim_grade"
  | "retracted"
  | "superseded"

export interface PublicationRecord {
  publication_id: string
  local_release_artifact_id: string
  local_release_digest: string
  dataset_repo_id: string
  repo_type: string
  target_revision: string | null
  pull_request_number: number | null
  remote_commit_sha: string | null
  remote_tree_digest: string | null
  release_version: string
  publication_state: PublicationState
  publisher_tool_version: string
  invocation_id: string | null
  source_commit: string | null
  dataset_card_digest: string | null
  schema_digest: string | null
  manifest_digest: string | null
  remote_verification_receipt_id: string | null
  published_at: string | null
  created_at: string
}

export interface RunRow {
  experiment_id: string
  run_id: string
  artifact_id: string
  machine_profile_id: string
  compute_image_digest: string | null
  runtime_binary_digest: string | null
  source_commit: string
  profile_digest: string | null
  operation_signature: string
  evidence_grade: EvidenceGrade
  authorization_revision: string | null
  superseded_by: string | null
  retraction_reason: string | null
  started_at: string
  completed_at: string | null
  backend: string
  model_id: string
  prompt_length: number
  output_tokens: number
}

export interface OperationRow {
  run_id: string
  operation_id: string
  operation_name: string
  duration_ms: number
  tokens_per_second: number | null
  memory_bytes: number | null
  power_watts: number | null
  artifact_id: string | null
}

export interface DatasetReleaseManifest {
  release_version: string
  release_id: string
  local_release_artifact_id: string
  local_release_digest: string
  dataset_repo_id: string
  created_at: string
  files: Array<{ path: string; digest: string; size_bytes: number }>
  artifact_count: number
  run_count: number
  operation_count: number
  tables: string[]
  evidence_grades: EvidenceGrade[]
  source_commit: string
  publisher_version: string
}
