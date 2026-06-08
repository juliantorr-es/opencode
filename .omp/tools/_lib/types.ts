// === OMP Custom Tools Foundation — Canonical Types v1 ===
// These types define the contract for all OMP bootstrap tools.
// Tribunus may later adopt or wrap them, but OMP owns them.
import type { OmpRelationalStoreV1 } from "./store/pglite-types.js"

// ── Error taxonomy ──

export type OmpErrorCodeV1 =
  | "INVALID_INPUT"
  | "INVALID_JSON"
  | "PATH_DENIED"
  | "PATH_NOT_FOUND"
  | "PATH_NOT_FILE"
  | "FILE_TOO_LARGE"
  | "HASH_REQUIRED"
  | "HASH_MISMATCH"
  | "MATCH_NOT_FOUND"
  | "MATCH_NOT_UNIQUE"
  | "OVERLAPPING_EDITS"
  | "UNSUPPORTED_ENCODING"
  | "WRITE_JOURNAL_FAILED"
  | "WRITE_FAILED"
  | "RECEIPT_FAILED"
  | "DIFF_FAILED"
  | "AUDIT_EVENT_FAILED"
  | "PATH_LOCK_CONFLICT"
  | "SESSION_NOT_ACTIVE"
  | "WORK_CLAIM_CONFLICT"
  | "STORE_MIGRATION_FAILED"
  | "STORE_WRITE_FAILED"
  | "PROJECTION_FAILED"
  | "INTERNAL_ERROR"

// ── Authority profile ──

export type OmpRiskLevel =
  | "read"
  | "write_low"
  | "write_medium"
  | "write_high"
  | "exec"
  | "network"
  | "memory_authority"
  | "external_service"

export type OmpSideEffect =
  | "none"
  | "filesystem_read"
  | "filesystem_write"
  | "process_exec"
  | "network"
  | "external_service"
  | "memory_write"

export type OmpAuthorityProfileV1 = {
  risk_level: OmpRiskLevel
  side_effects: OmpSideEffect
  requires_approval: boolean
  requires_hash_precondition: boolean
  allowed_roots: string[]
  denied_patterns: string[]
  max_input_bytes?: number
  max_output_bytes?: number
  max_files_touched?: number
  max_file_bytes?: number
}

// ── Tool context ──

export type OmpToolContextV1 = {
  cwd: string
  repo_root: string
  mode: "loose" | "governed" | "ci"
  actor: OmpActorV1
  session_id: string
  limits: {
    max_file_bytes: number
    max_output_bytes: number
    max_files_touched: number
    path_lock_ttl_ms: number
  }
  paths: {
    receipts_dir: string
    diffs_dir: string
    events_path: string
    journals_dir: string
    evidence_root: string
    pglite_dir: string
    duckdb_path: string
  }
  store?: OmpRelationalStoreV1
}

export type OmpActorV1 = {
  kind: "human" | "agent" | "system" | "unknown"
  provider?: string
  model?: string
  session_id?: string
}

// ── Path policy ──

export type PathPolicyDecisionV1 = {
  ok: boolean
  normalized_path?: string
  absolute_path?: string
  reason?: string
  denied_pattern?: string
}

// ── Canonical envelope (returned to caller) ──

export type OmpToolEnvelopeV1 = {
  schema: "omp.tool.envelope.v1"
  tool_id: string
  tool_version: string
  invocation_id: string
  receipt_id?: string
  status: "ok" | "error" | "refused"
  started_at: string
  finished_at: string
  duration_ms: number
  cwd: string
  actor: OmpActorV1
  input: {
    sha256: string
    redacted_preview?: unknown
  }
  policy: {
    risk_level: OmpRiskLevel
    requires_approval: boolean
    approval_id?: string
    requires_hash_precondition: boolean
    policy_decision: "allowed" | "refused"
    policy_reasons: string[]
  }
  paths: {
    read: string[]
    written: string[]
    denied: string[]
  }
  result?: unknown
  evidence?: {
    receipt_path?: string
    diff_paths?: string[]
    journal_path?: string
    event_path?: string
    before_hashes?: Record<string, string>
    after_hashes?: Record<string, string>
  }
  error?: {
    code: OmpErrorCodeV1
    message: string
    details?: unknown
    retryable: boolean
  }
}

// ── Canonical receipt (durable evidence) ──

export type OmpToolReceiptV1 = {
  schema: "omp.tool.receipt.v1"
  receipt_id: string
  invocation_id: string
  tool_id: string
  tool_version: string
  created_at: string
  cwd: string
  actor: OmpActorV1
  command: {
    input_sha256: string
    normalized_input_sha256: string
    input_redacted_preview?: unknown
  }
  authority: {
    risk_level: OmpRiskLevel
    approval_id?: string
    requires_hash_precondition: boolean
    hash_precondition_satisfied: boolean
    path_policy_satisfied: boolean
  }
  files: Array<{
    path: string
    action: "read" | "write" | "create" | "delete"
    before_sha256?: string
    expected_before_sha256?: string
    after_sha256?: string
    before_size_bytes?: number
    after_size_bytes?: number
    diff_path?: string
  }>
  result: {
    status: "ok" | "error" | "refused"
    summary: string
  }
  artifacts: {
    receipt_path: string
    diff_paths: string[]
    journal_path?: string
    event_path: string
  }
  integrity: {
    receipt_sha256?: string
    previous_event_sha256?: string
    event_sha256?: string
  }
}

// ── Audit event (JSONL index) ──

export type OmpToolEventV1 = {
  schema: "omp.tool.event.v1"
  event_id: string
  timestamp: string
  invocation_id: string
  receipt_id?: string
  tool_id: string
  tool_version: string
  status: "ok" | "error" | "refused"
  risk_level: OmpRiskLevel
  paths: {
    read: string[]
    written: string[]
    denied: string[]
  }
  input_sha256: string
  output_sha256?: string
  receipt_path?: string
  diff_paths?: string[]
  previous_event_sha256?: string
  event_sha256?: string
}

// ── Tool manifest (provider-neutral) ──

export type OmpToolManifestV1 = {
  schema: "omp.tool.manifest.v1"
  tool_id: string
  version: string
  title: string
  description: string
  authority: OmpAuthorityProfileV1
  input_schema: unknown
  output_schema: unknown
  receipt_schema?: unknown
  examples?: Array<{
    name: string
    input: unknown
    expected_status: "ok" | "error" | "refused"
  }>
  provider_exports: {
    mistral_function_calling: boolean
    openai_tools: boolean
    anthropic_tools: boolean
    mcp: boolean
  }
}

// ── Write journal (crash-safe) ──

export type OmpWriteJournalV1 = {
  schema: "omp.write_journal.v1"
  journal_id: string
  receipt_id: string
  created_at: string
  status: "prepared" | "committing" | "committed" | "rollback_needed" | "rolled_back"
  files: Array<{
    path: string
    before_sha256: string
    staged_path: string
    backup_path: string
    after_sha256: string
  }>
}

// ── Approval ──

export type OmpApprovalV1 = {
  approval_id: string
  approved_by: "human" | "policy"
  approved_at: string
  scope: {
    tool_ids: string[]
    paths: string[]
    expires_at?: string
  }
}

// ── MCP server risk manifest ──

export type OmpMcpServerManifestV1 = {
  schema: "omp.mcp_server.manifest.v1"
  server_id: string
  command: string
  args: string[]
  risk_level: OmpRiskLevel
  allowed_tools?: string[]
  denied_tools?: string[]
  requires_approval: boolean
  receipt_required: boolean
  env_policy: {
    allowed_env_keys: string[]
    redacted_env_keys: string[]
  }
}
