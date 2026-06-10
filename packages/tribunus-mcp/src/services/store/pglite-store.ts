// === PGlite Coordination Store — Durable Coordination Truth Layer ===
// Implements OmpRelationalStoreV1 using @electric-sql/pglite as the backend.
// Singleton per repo — use getPgliteStore() factory.

import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import type {
  OmpRelationalStoreV1,
  ActorRecordV1,
  SessionRecordV1,
  PathLockRecordV1,
  ToolInvocationRecordV1,
  ToolFileEffectRecordV1,
  WriteJournalRecordV1,
  CreateActorInputV1,
  CreateSessionInputV1,
  ClaimWorkInputV1,
  ClaimWorkResultV1,
  AcquirePathLocksInputV1,
  AcquirePathLocksResultV1,
  ReleasePathLocksInputV1,
  RecordMutationInputV1,
  RecordReadInputV1,
  UpdateWriteJournalStatusInputV1,
  ExpiredSessionReportV1,
  PGliteStoreOptionsV1,
} from "./pglite-types.js"
import type { PGliteConstructor, PGliteLike } from "./pglite-runtime.js"
import { loadPGliteConstructor } from "./pglite-runtime.js"
import { runMigrations } from "./pglite-migrations.js"
import { getPgliteDir } from "../config.js"

// ── Defaults ──

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000   // 30 minutes
const DEFAULT_PATH_LOCK_TTL_MS = 5 * 60 * 1000  // 5 minutes
const DEFAULT_WORK_CLAIM_TTL_MS = 10 * 60 * 1000 // 10 minutes

// ── Row mapping helpers ──

function mapRowToActor(row: Record<string, unknown>): ActorRecordV1 {
  return {
    actor_id: String(row.actor_id),
    kind: row.kind as ActorRecordV1["kind"],
    provider: row.provider ? String(row.provider) : undefined,
    model: row.model ? String(row.model) : undefined,
    display_name: row.display_name ? String(row.display_name) : undefined,
    created_at: String(row.created_at),
  }
}

function mapRowToSession(row: Record<string, unknown>): SessionRecordV1 {
  return {
    session_id: String(row.session_id),
    actor_id: String(row.actor_id),
    status: row.status as SessionRecordV1["status"],
    purpose: row.purpose ? String(row.purpose) : undefined,
    started_at: String(row.started_at),
    last_heartbeat_at: String(row.last_heartbeat_at),
    closed_at: row.closed_at ? String(row.closed_at) : undefined,
  }
}

function mapRowToPathLock(row: Record<string, unknown>): PathLockRecordV1 {
  return {
    lock_id: String(row.lock_id),
    path: String(row.path),
    lock_kind: row.lock_kind as PathLockRecordV1["lock_kind"],
    session_id: String(row.session_id),
    work_id: row.work_id ? String(row.work_id) : undefined,
    status: row.status as PathLockRecordV1["status"],
    acquired_at: String(row.acquired_at),
    expires_at: String(row.expires_at),
    released_at: row.released_at ? String(row.released_at) : undefined,
  }
}

function mapRowToInvocation(row: Record<string, unknown>): ToolInvocationRecordV1 {
  return {
    invocation_id: String(row.invocation_id),
    session_id: String(row.session_id),
    work_id: row.work_id ? String(row.work_id) : undefined,
    tool_id: String(row.tool_id),
    tool_version: String(row.tool_version),
    status: row.status as ToolInvocationRecordV1["status"],
    risk_level: String(row.risk_level),
    started_at: String(row.started_at),
    finished_at: String(row.finished_at),
    duration_ms: Number(row.duration_ms),
    input_sha256: String(row.input_sha256),
    output_sha256: row.output_sha256 ? String(row.output_sha256) : undefined,
    receipt_id: row.receipt_id ? String(row.receipt_id) : undefined,
    error_code: row.error_code ? String(row.error_code) : undefined,
    error_message: row.error_message ? String(row.error_message) : undefined,
  }
}

function mapRowToFileEffect(row: Record<string, unknown>): ToolFileEffectRecordV1 {
  return {
    effect_id: String(row.effect_id),
    receipt_id: row.receipt_id ? String(row.receipt_id) : undefined,
    invocation_id: String(row.invocation_id),
    session_id: String(row.session_id),
    path: String(row.path),
    action: row.action as ToolFileEffectRecordV1["action"],
    before_sha256: row.before_sha256 ? String(row.before_sha256) : undefined,
    expected_before_sha256: row.expected_before_sha256 ? String(row.expected_before_sha256) : undefined,
    after_sha256: row.after_sha256 ? String(row.after_sha256) : undefined,
    before_size_bytes: row.before_size_bytes != null ? Number(row.before_size_bytes) : undefined,
    after_size_bytes: row.after_size_bytes != null ? Number(row.after_size_bytes) : undefined,
    diff_path: row.diff_path ? String(row.diff_path) : undefined,
    diff_sha256: row.diff_sha256 ? String(row.diff_sha256) : undefined,
  }
}

function mapRowToWriteJournal(row: Record<string, unknown>): WriteJournalRecordV1 {
  return {
    journal_id: String(row.journal_id),
    receipt_id: row.receipt_id ? String(row.receipt_id) : undefined,
    invocation_id: String(row.invocation_id),
    session_id: String(row.session_id),
    status: row.status as WriteJournalRecordV1["status"],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    journal_path: String(row.journal_path),
  }
}

// ── Store Implementation ──

class PGliteStoreV1Impl implements OmpRelationalStoreV1 {
  private db: PGliteLike | null = null
  private dbCtor: PGliteConstructor | null = null
  private options: PGliteStoreOptionsV1
  private stateDir: string

  constructor(options: PGliteStoreOptionsV1) {
    this.options = { ...options }
    this.stateDir = getPgliteDir()
  }

  // ── Connection ──

  private async ensureDb(): Promise<PGliteLike> {
    if (this.db) return this.db

    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true })
    }

    if (!this.dbCtor) {
      this.dbCtor = await loadPGliteConstructor(this.options.repoRoot)
    }

    this.db = new this.dbCtor(this.stateDir)
    return this.db
  }

  private async tx<T>(fn: (db: PGliteLike) => Promise<T>): Promise<T> {
    const db = await this.ensureDb()
    await db.exec("BEGIN")
    try {
      const result = await fn(db)
      await db.exec("COMMIT")
      return result
    } catch (err) {
      await db.exec("ROLLBACK")
      throw err
    }
  }

  // ── Migrate ──

  async migrate(): Promise<void> {
    const db = await this.ensureDb()
    await runMigrations(db)
  }

  /** Close the underlying PGlite database connection. */
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close()
      this.db = null
    }
  }

  // ── Actors ──

  async createActor(input: CreateActorInputV1): Promise<ActorRecordV1> {
    return this.tx(async (db) => {
      const now = new Date().toISOString()
      const validKinds: string[] = ["human", "agent", "system", "unknown"]
      const kind = validKinds.includes(input.kind) ? input.kind : "unknown"

      await db.query(
        `INSERT INTO actors (actor_id, kind, provider, model, display_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.actor_id, kind, input.provider ?? null, input.model ?? null, input.display_name ?? null, now],
      )

      return mapRowToActor({
        actor_id: input.actor_id,
        kind,
        provider: input.provider,
        model: input.model,
        display_name: input.display_name,
        created_at: now,
      })
    })
  }

  // ── Sessions ──

  async createSession(input: CreateSessionInputV1): Promise<SessionRecordV1> {
    return this.tx(async (db) => {
      const now = new Date().toISOString()

      await db.query(
        `INSERT INTO sessions (session_id, actor_id, status, purpose, started_at, last_heartbeat_at)
         VALUES ($1, $2, 'active', $3, $4, $5)`,
        [input.session_id, input.actor_id, input.purpose ?? null, now, now],
      )

      return mapRowToSession({
        session_id: input.session_id,
        actor_id: input.actor_id,
        status: "active",
        purpose: input.purpose,
        started_at: now,
        last_heartbeat_at: now,
      })
    })
  }

  async heartbeatSession(session_id: string): Promise<void> {
    const db = await this.ensureDb()
    const now = new Date().toISOString()
    await db.query(
      `UPDATE sessions SET last_heartbeat_at = $1, status = CASE WHEN status IN ('idle') THEN 'active' ELSE status END WHERE session_id = $2`,
      [now, session_id],
    )
  }

  async closeSession(session_id: string): Promise<void> {
    const db = await this.ensureDb()
    const now = new Date().toISOString()
    await db.query(
      `UPDATE sessions SET status = 'closed', closed_at = $1 WHERE session_id = $2 AND status NOT IN ('closed', 'abandoned')`,
      [now, session_id],
    )
  }

  async abandonExpiredSessions(now?: Date): Promise<ExpiredSessionReportV1> {
    const cutoff = (now ?? new Date()).toISOString()
    const sessionTtl = this.options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    const lockTtl = this.options.pathLockTtlMs ?? DEFAULT_PATH_LOCK_TTL_MS
    const claimTtl = this.options.workClaimTtlMs ?? DEFAULT_WORK_CLAIM_TTL_MS

    const db = await this.ensureDb()

    // Compute the heartbeat cutoff: sessions whose last_heartbeat_at is older than TTL
    // Since we work with ISO strings, use strftime for comparison in SQLite/PGlite
    // PGlite is Postgres-compatible, so use NOW() - interval
    const sessionCutoff = new Date(Date.now() - sessionTtl).toISOString()

    // Find abandoned sessions
    const abandonResult = await db.query<{ session_id: string }>(
      `UPDATE sessions SET status = 'abandoned', closed_at = $1
       WHERE status IN ('starting', 'active', 'idle', 'closing')
         AND last_heartbeat_at < $2
       RETURNING session_id`,
      [cutoff, sessionCutoff],
    )
    const abandonedSessionIds = abandonResult.rows.map((r) => r.session_id)

    // Expire path locks for abandoned sessions
    await db.query(
      `UPDATE path_locks SET status = 'expired', released_at = $1
       WHERE status = 'active' AND session_id = ANY($2::text[])`,
      [cutoff, abandonedSessionIds],
    )
    const lockExpireResult = await db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM path_locks WHERE status = 'expired' AND released_at = $1 AND session_id = ANY($2::text[])`,
      [cutoff, abandonedSessionIds],
    )
    const expiredLockCount = Number(lockExpireResult.rows[0]?.count ?? 0)

    // Expire old path locks (beyond TTL even if session is active — for safety)
    await db.query(
      `UPDATE path_locks SET status = 'expired', released_at = $1
       WHERE status = 'active' AND expires_at < $2`,
      [cutoff, cutoff],
    )

    // Expire old work claims (beyond TTL)
    await db.query(
      `UPDATE work_claims SET status = 'expired', released_at = $1
       WHERE status = 'active' AND expires_at < $2`,
      [cutoff, cutoff],
    )
    const claimExpireResult = await db.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM work_claims WHERE status = 'expired' AND released_at = $1`,
      [cutoff],
    )
    const expiredClaimCount = Number(claimExpireResult.rows[0]?.count ?? 0)

    return {
      abandoned_count: abandonedSessionIds.length,
      abandoned_session_ids: abandonedSessionIds,
      expired_lock_count: expiredLockCount,
      expired_claim_count: expiredClaimCount,
    }
  }

  // ── Work Claims ──

  async claimWork(input: ClaimWorkInputV1): Promise<ClaimWorkResultV1> {
    return this.tx(async (db) => {
      // Check if there's already an active claim
      const activeClaim = await db.query<{ claim_id: string; session_id: string }>(
        `SELECT claim_id, session_id FROM work_claims
         WHERE work_id = $1 AND status = 'active'`,
        [input.work_id],
      )

      if (activeClaim.rows.length > 0) {
        return {
          claimed: false,
          conflict_session_id: activeClaim.rows[0].session_id,
        }
      }

      // Find the work item and claim it
      const workItem = await db.query<{ work_id: string; status: string }>(
        `SELECT work_id, status FROM work_items WHERE work_id = $1`,
        [input.work_id],
      )

      if (workItem.rows.length === 0) {
        return { claimed: false }
      }

      const status = workItem.rows[0].status
      if (status !== "queued" && status !== "blocked") {
        return { claimed: false }
      }

      const claimId = randomUUID()
      const now = new Date()
      const ttl = input.ttl_ms ?? DEFAULT_WORK_CLAIM_TTL_MS
      const expiresAt = new Date(now.getTime() + ttl).toISOString()
      const nowIso = now.toISOString()

      await db.query(
        `INSERT INTO work_claims (claim_id, work_id, session_id, status, claimed_at, expires_at)
         VALUES ($1, $2, $3, 'active', $4, $5)`,
        [claimId, input.work_id, input.session_id, nowIso, expiresAt],
      )

      await db.query(
        `UPDATE work_items SET status = 'claimed', updated_at = $1 WHERE work_id = $2`,
        [nowIso, input.work_id],
      )

      return { claimed: true, claim_id: claimId }
    })
  }

  async releaseWorkClaim(claim_id: string): Promise<void> {
    const db = await this.ensureDb()
    const now = new Date().toISOString()
    await db.query(
      `UPDATE work_claims SET status = 'released', released_at = $1 WHERE claim_id = $2 AND status = 'active'`,
      [now, claim_id],
    )
  }

  // ── Path Locks ──

  async acquirePathLocks(input: AcquirePathLocksInputV1): Promise<AcquirePathLocksResultV1> {
    return this.tx(async (db) => {
      const ttl = input.ttl_ms ?? DEFAULT_PATH_LOCK_TTL_MS
      const now = new Date()
      const expiresAt = new Date(now.getTime() + ttl).toISOString()
      const nowIso = now.toISOString()
      const lockIds: string[] = []

      // Check for conflicting active locks on requested paths
      // Write locks conflict with any active lock on the same path
      // Read locks conflict only with active write locks on the same path
      const conflicts: AcquirePathLocksResultV1["conflicts"] = []

      for (const req of input.paths) {
        let conflictQuery: string
        let conflictParams: string[]

        if (req.lock_kind === "write") {
          // Write lock conflicts with any active lock (read or write) on the same path
          conflictQuery = `SELECT lock_id, session_id, path, expires_at FROM path_locks
            WHERE path = $1 AND status = 'active' AND expires_at > $2
            FOR UPDATE`
          conflictParams = [req.path, nowIso]
        } else {
          // Read lock conflicts only with active write locks
          conflictQuery = `SELECT lock_id, session_id, path, expires_at FROM path_locks
            WHERE path = $1 AND lock_kind = 'write' AND status = 'active' AND expires_at > $2
            FOR UPDATE`
          conflictParams = [req.path, nowIso]
        }

        const existing = await db.query<{ lock_id: string; session_id: string; path: string; expires_at: string }>(
          conflictQuery,
          conflictParams,
        )

        for (const lock of existing.rows) {
          // Skip locks owned by the requesting session
          if (lock.session_id === input.session_id) continue

          conflicts.push({
            path: lock.path,
            owning_session_id: lock.session_id,
            lock_id: lock.lock_id,
            expires_at: lock.expires_at,
          })
        }

        if (existing.rows.length > 0 && existing.rows.some((r) => r.session_id !== input.session_id)) {
          // There's a conflict — don't acquire for this path
          continue
        }

        // No conflict — acquire the lock
        const lockId = randomUUID()
        lockIds.push(lockId)

        await db.query(
          `INSERT INTO path_locks (lock_id, path, lock_kind, session_id, work_id, status, acquired_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)`,
          [lockId, req.path, req.lock_kind, input.session_id, input.work_id ?? null, nowIso, expiresAt],
        )
      }

      if (conflicts.length > 0) {
        return { acquired: false, conflicts }
      }

      return { acquired: true, lock_ids: lockIds }
    })
  }

  async releasePathLocks(input: ReleasePathLocksInputV1): Promise<void> {
    const db = await this.ensureDb()
    const now = new Date().toISOString()

    // Only release locks owned by the requesting session
    for (const lockId of input.lock_ids) {
      await db.query(
        `UPDATE path_locks SET status = 'released', released_at = $1
         WHERE lock_id = $2 AND session_id = $3 AND status = 'active'`,
        [now, lockId, input.session_id],
      )
    }
  }

  async findConflictingLocks(paths: string[]): Promise<PathLockRecordV1[]> {
    const db = await this.ensureDb()
    const now = new Date().toISOString()

    // Build parameterized query with array
    const result = await db.query<Record<string, unknown>>(
      `SELECT * FROM path_locks
       WHERE path = ANY($1::text[]) AND status = 'active' AND expires_at > $2
       ORDER BY acquired_at DESC`,
      [paths, now],
    )

    return result.rows.map(mapRowToPathLock)
  }

  // ── Tool Invocations ──

  async recordInvocation(input: ToolInvocationRecordV1): Promise<void> {
    const db = await this.ensureDb()
    await db.query(
      `INSERT INTO tool_invocations (invocation_id, session_id, work_id, tool_id, tool_version,
         status, risk_level, started_at, finished_at, duration_ms, input_sha256,
         output_sha256, receipt_id, error_code, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        input.invocation_id,
        input.session_id,
        input.work_id ?? null,
        input.tool_id,
        input.tool_version,
        input.status,
        input.risk_level,
        input.started_at,
        input.finished_at,
        input.duration_ms,
        input.input_sha256,
        input.output_sha256 ?? null,
        input.receipt_id ?? null,
        input.error_code ?? null,
        input.error_message ?? null,
      ],
    )
  }

  // ── File Effects ──

  async recordMutation(input: RecordMutationInputV1): Promise<void> {
    const db = await this.ensureDb()
    const effectId = randomUUID()

    await db.query(
      `INSERT INTO tool_file_effects (effect_id, receipt_id, invocation_id, session_id,
         path, action, before_sha256, expected_before_sha256, after_sha256,
         before_size_bytes, after_size_bytes, diff_path, diff_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        effectId,
        input.receipt_id ?? null,
        input.invocation_id,
        input.session_id,
        input.path,
        input.action,
        input.before_sha256 ?? null,
        input.expected_before_sha256 ?? null,
        input.after_sha256 ?? null,
        input.before_size_bytes ?? null,
        input.after_size_bytes ?? null,
        input.diff_path ?? null,
        input.diff_sha256 ?? null,
      ],
    )
  }

  async recordInvocationWithMutations(input: {
    invocation: ToolInvocationRecordV1
    mutations: RecordMutationInputV1[]
  }): Promise<void> {
    await this.tx(async (db) => {
      await db.query(
        `INSERT INTO tool_invocations (invocation_id, session_id, work_id, tool_id, tool_version,
           status, risk_level, started_at, finished_at, duration_ms, input_sha256,
           output_sha256, receipt_id, error_code, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          input.invocation.invocation_id,
          input.invocation.session_id,
          input.invocation.work_id ?? null,
          input.invocation.tool_id,
          input.invocation.tool_version,
          input.invocation.status,
          input.invocation.risk_level,
          input.invocation.started_at,
          input.invocation.finished_at,
          input.invocation.duration_ms,
          input.invocation.input_sha256,
          input.invocation.output_sha256 ?? null,
          input.invocation.receipt_id ?? null,
          input.invocation.error_code ?? null,
          input.invocation.error_message ?? null,
        ],
      )

      for (const mutation of input.mutations) {
        const effectId = randomUUID()
        await db.query(
          `INSERT INTO tool_file_effects (effect_id, receipt_id, invocation_id, session_id,
             path, action, before_sha256, expected_before_sha256, after_sha256,
             before_size_bytes, after_size_bytes, diff_path, diff_sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            effectId,
            mutation.receipt_id ?? null,
            mutation.invocation_id,
            mutation.session_id,
            mutation.path,
            mutation.action,
            mutation.before_sha256 ?? null,
            mutation.expected_before_sha256 ?? null,
            mutation.after_sha256 ?? null,
            mutation.before_size_bytes ?? null,
            mutation.after_size_bytes ?? null,
            mutation.diff_path ?? null,
            mutation.diff_sha256 ?? null,
          ],
        )
      }
    })
  }

  async recordRead(input: RecordReadInputV1): Promise<void> {
    const db = await this.ensureDb()
    const effectId = randomUUID()

    await db.query(
      `INSERT INTO tool_file_effects (effect_id, invocation_id, session_id, path, action,
         after_sha256, after_size_bytes)
       VALUES ($1, $2, $3, $4, 'read', $5, $6)`,
      [
        effectId,
        input.invocation_id,
        input.session_id,
        input.path,
        input.sha256,
        input.size_bytes,
      ],
    )
  }

  // ── Write Journals ──

  async createWriteJournal(input: WriteJournalRecordV1): Promise<void> {
    const db = await this.ensureDb()
    const now = new Date().toISOString()

    await db.query(
      `INSERT INTO write_journals (journal_id, receipt_id, invocation_id, session_id,
         status, created_at, updated_at, journal_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.journal_id,
        input.receipt_id ?? null,
        input.invocation_id,
        input.session_id,
        input.status,
        now,
        now,
        input.journal_path,
      ],
    )
  }

  async updateWriteJournalStatus(input: UpdateWriteJournalStatusInputV1): Promise<void> {
    const db = await this.ensureDb()
    const now = new Date().toISOString()

    await db.query(
      `UPDATE write_journals SET status = $1, updated_at = $2 WHERE journal_id = $3`,
      [input.status, now, input.journal_id],
    )
  }

  async findPendingJournals(): Promise<WriteJournalRecordV1[]> {
    const db = await this.ensureDb()

    const result = await db.query<Record<string, unknown>>(
      `SELECT * FROM write_journals
       WHERE status IN ('prepared', 'committing', 'rollback_needed')
       ORDER BY created_at ASC`,
    )

    return result.rows.map(mapRowToWriteJournal)
  }

  // ── Queries ──

  async listRecentInvocations(limit: number): Promise<ToolInvocationRecordV1[]> {
    const db = await this.ensureDb()
    const clampedLimit = Math.max(1, Math.min(limit, 1000))

    const result = await db.query<Record<string, unknown>>(
      `SELECT * FROM tool_invocations ORDER BY started_at DESC LIMIT $1`,
      [clampedLimit],
    )

    return result.rows.map(mapRowToInvocation)
  }

  async listEffectsForPath(path: string): Promise<ToolFileEffectRecordV1[]> {
    const db = await this.ensureDb()

    const result = await db.query<Record<string, unknown>>(
      `SELECT * FROM tool_file_effects WHERE path = $1 ORDER BY effect_id DESC`,
      [path],
    )

    return result.rows.map(mapRowToFileEffect)
  }
}

// ── Singleton Management ──

const instances = new Map<string, PGliteStoreV1Impl>()

/**
 * Get or create the PGlite store singleton for the given repo root.
 *
 * ```ts
 * const store = getPgliteStore({ repoRoot: process.cwd() })
 * await store.migrate()
 * ```
 */
export function getPgliteStore(options: PGliteStoreOptionsV1): OmpRelationalStoreV1 {
  const key = resolve(options.repoRoot)
  let store = instances.get(key)
  if (!store) {
    store = new PGliteStoreV1Impl(options)
    instances.set(key, store)
  }
  return store
}

/**
 * Close the PGlite store for the given repo root and remove it from the singleton cache.
 */
export async function closePgliteStore(repoRoot: string): Promise<void> {
  const key = resolve(repoRoot)
  const store = instances.get(key)
  if (store) {
    await store.close()
    instances.delete(key)
  }
}
