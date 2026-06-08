// === DuckDB Analytical Projections — Canonical Result Types v1 ===
// Return row shapes for each DuckDB analytical view.

export type SessionSummaryV1 = {
  session_id: string
  actor_id: string
  status: string
  invocation_count: number
  write_count: number
  read_count: number
  refusal_count: number
  error_count: number
  first_activity: string
  last_activity: string
}

export type ToolQualityV1 = {
  tool_id: string
  total_invocations: number
  ok_count: number
  refused_count: number
  error_count: number
  median_duration_ms: number
}

export type FileChurnV1 = {
  path: string
  read_count: number
  write_count: number
  last_before_sha256: string
  last_after_sha256: string
  last_touched_at: string
}

export type StaleWriteRefusalV1 = {
  invocation_id: string
  session_id: string
  path: string
  expected_before_sha256: string
  actual_before_sha256: string
  created_at: string
}

export type PathLockConflictV1 = {
  path: string
  requesting_session_id: string
  owning_session_id: string
  lock_id: string
  conflict_time: string
}

export type RecoveryItemV1 = {
  category: string
  item_id: string
  description: string
  created_at: string
}
