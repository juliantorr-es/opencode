// === PGlite Coordination Store — Canonical Types ===
// Database row types and input/output types for the OMP relational store.

// ── Database Row Records ──

export type ActorRecordV1 = {
  actor_id: string
  kind: "human" | "agent" | "system" | "unknown"
  provider?: string
  model?: string
  display_name?: string
  created_at: string
}

export type SessionRecordV1 = {
  session_id: string
  actor_id: string
  status: "starting" | "active" | "idle" | "closing" | "closed" | "abandoned"
  purpose?: string
  started_at: string
  last_heartbeat_at: string
  closed_at?: string
}

export type WorkItemRecordV1 = {
  work_id: string
  kind: string
  title: string
  status: "queued" | "claimed" | "running" | "blocked" | "completed" | "failed" | "cancelled"
  priority: number
  created_by_session_id?: string
  created_at: string
  updated_at: string
}

export type WorkClaimRecordV1 = {
  claim_id: string
  work_id: string
  session_id: string
  status: "active" | "released" | "expired" | "completed"
  claimed_at: string
  expires_at: string
  released_at?: string
}

export type PathLockRecordV1 = {
  lock_id: string
  path: string
  lock_kind: "read" | "write"
  session_id: string
  work_id?: string
  status: "active" | "released" | "expired"
  acquired_at: string
  expires_at: string
  released_at?: string
}

export type ToolInvocationRecordV1 = {
  invocation_id: string
  session_id: string
  work_id?: string
  tool_id: string
  tool_version: string
  status: "ok" | "error" | "refused"
  risk_level: string
  started_at: string
  finished_at: string
  duration_ms: number
  input_sha256: string
  output_sha256?: string
  receipt_id?: string
  error_code?: string
  error_message?: string
}

export type ToolReceiptRecordV1 = {
  receipt_id: string
  invocation_id: string
  session_id: string
  tool_id: string
  tool_version: string
  status: "ok" | "error" | "refused"
  created_at: string
  receipt_path: string
  receipt_sha256?: string
  event_path?: string
  journal_path?: string
  summary: string
}

export type ToolFileEffectRecordV1 = {
  effect_id: string
  receipt_id?: string
  invocation_id: string
  session_id: string
  path: string
  action: "read" | "write" | "create" | "delete"
  before_sha256?: string
  expected_before_sha256?: string
  after_sha256?: string
  before_size_bytes?: number
  after_size_bytes?: number
  diff_path?: string
  diff_sha256?: string
}

export type WriteJournalRecordV1 = {
  journal_id: string
  receipt_id?: string
  invocation_id: string
  session_id: string
  status: "prepared" | "committing" | "committed" | "rollback_needed" | "rolled_back" | "abandoned"
  created_at: string
  updated_at: string
  journal_path: string
}

export type CoordinationEventRecordV1 = {
  event_id: string
  session_id?: string
  work_id?: string
  invocation_id?: string
  event_type: string
  payload_json: object
  created_at: string
}

// ── Migration Record ──

export type SchemaMigrationRecordV1 = {
  version: string
  applied_at: string
  checksum?: string
}

// ── Input Types ──

export type CreateActorInputV1 = {
  actor_id: string
  kind: string
  provider?: string
  model?: string
  display_name?: string
}

export type CreateSessionInputV1 = {
  session_id: string
  actor_id: string
  purpose?: string
}

export type ClaimWorkInputV1 = {
  work_id: string
  session_id: string
  ttl_ms?: number
}

export type ClaimWorkResultV1 = {
  claimed: boolean
  claim_id?: string
  conflict_session_id?: string
}

export type AcquirePathLocksInputV1 = {
  paths: Array<{ path: string; lock_kind: "read" | "write" }>
  session_id: string
  work_id?: string
  ttl_ms?: number
}

export type AcquirePathLocksResultV1 = {
  acquired: boolean
  lock_ids?: string[]
  conflicts?: Array<{
    path: string
    owning_session_id: string
    lock_id: string
    expires_at: string
  }>
}

export type ReleasePathLocksInputV1 = {
  lock_ids: string[]
  session_id: string
}

export type RecordMutationInputV1 = {
  invocation_id: string
  session_id: string
  receipt_id?: string
  path: string
  action: "write" | "create" | "delete"
  before_sha256?: string
  expected_before_sha256?: string
  after_sha256?: string
  before_size_bytes?: number
  after_size_bytes?: number
  diff_path?: string
  diff_sha256?: string
}

export type RecordReadInputV1 = {
  invocation_id: string
  session_id: string
  path: string
  sha256: string
  size_bytes: number
}

export type UpdateWriteJournalStatusInputV1 = {
  journal_id: string
  status: string
}

export type ExpiredSessionReportV1 = {
  abandoned_count: number
  abandoned_session_ids: string[]
  expired_lock_count: number
  expired_claim_count: number
}

// ── Store Configuration ──

export type PGliteStoreOptionsV1 = {
  repoRoot: string
  sessionTtlMs?: number
  pathLockTtlMs?: number
  workClaimTtlMs?: number
}

// ── Store Interface ──

export interface OmpRelationalStoreV1 {
  migrate(): Promise<void>
  createActor(input: CreateActorInputV1): Promise<ActorRecordV1>
  createSession(input: CreateSessionInputV1): Promise<SessionRecordV1>
  heartbeatSession(session_id: string): Promise<void>
  closeSession(session_id: string): Promise<void>
  abandonExpiredSessions(now?: Date): Promise<ExpiredSessionReportV1>
  claimWork(input: ClaimWorkInputV1): Promise<ClaimWorkResultV1>
  releaseWorkClaim(claim_id: string): Promise<void>
  acquirePathLocks(input: AcquirePathLocksInputV1): Promise<AcquirePathLocksResultV1>
  releasePathLocks(input: ReleasePathLocksInputV1): Promise<void>
  findConflictingLocks(paths: string[]): Promise<PathLockRecordV1[]>
  recordInvocation(input: ToolInvocationRecordV1): Promise<void>
  recordMutation(input: RecordMutationInputV1): Promise<void>
  recordInvocationWithMutations(input: {
    invocation: ToolInvocationRecordV1
    mutations: RecordMutationInputV1[]
  }): Promise<void>
  recordRead(input: RecordReadInputV1): Promise<void>
  createWriteJournal(input: WriteJournalRecordV1): Promise<void>
  updateWriteJournalStatus(input: UpdateWriteJournalStatusInputV1): Promise<void>
  findPendingJournals(): Promise<WriteJournalRecordV1[]>
  listRecentInvocations(limit: number): Promise<ToolInvocationRecordV1[]>
  listEffectsForPath(path: string): Promise<ToolFileEffectRecordV1[]>
}
