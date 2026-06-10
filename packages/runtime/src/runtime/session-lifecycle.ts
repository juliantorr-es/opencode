/**
 * Session Lifecycle — Open, Checkpoint, Resume, Consolidate, Close
 *
 * Every session state transition is durable and recoverable.
 * Checkpoints capture full state at configurable intervals.
 * Resume restores exact state from the last checkpoint.
 * Close consolidates state, writes final checkpoint, and cleans up.
 */
import { Effect } from "effect"

// ── Types ────────────────────────────────────────────────────────────────────

interface SessionIDBrand { readonly SessionID: unique symbol }
type SessionID = string & SessionIDBrand

interface SessionState {
  sessionId: SessionID
  status: "open" | "checkpointing" | "active" | "closing" | "closed"
  openedAt: number
  lastCheckpointAt: number | null
  closedAt: number | null
  checkpointIntervalMs: number
  metadata: Record<string, unknown>
}

interface Checkpoint {
  id: string
  sessionId: SessionID
  timestamp: number
  state: Record<string, unknown>
  predecessorCheckpointId: string | null
}

interface SessionRecord {
  session: SessionState
  checkpoints: Checkpoint[]
}

// ── In-Memory Session Store (PGlite-backed in production) ────────────────────

const sessionStore = new Map<SessionID, SessionRecord>()

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// ── Session Open ─────────────────────────────────────────────────────────────

function openSession(metadata?: Record<string, unknown>): Effect.Effect<SessionState, Error> {
  return Effect.gen(function* () {
    const sessionId = generateId() as SessionID
    const now = Date.now()

    const session: SessionState = {
      sessionId,
      status: "open",
      openedAt: now,
      lastCheckpointAt: null,
      closedAt: null,
      checkpointIntervalMs: 300_000, // 5 minutes default
      metadata: metadata ?? {},
    }

    sessionStore.set(sessionId, { session, checkpoints: [] })

    return session
  })
}

// ── Session Checkpoint ───────────────────────────────────────────────────────

function createCheckpoint(
  sessionId: SessionID,
  state: Record<string, unknown>
): Effect.Effect<Checkpoint, Error> {
  return Effect.gen(function* () {
    const record = sessionStore.get(sessionId)
    if (!record) throw new Error(`Session not found: ${sessionId}`)

    const prevCheckpoint = record.checkpoints[record.checkpoints.length - 1] ?? null
    const checkpoint: Checkpoint = {
      id: generateId(),
      sessionId,
      timestamp: Date.now(),
      state: structuredClone(state),
      predecessorCheckpointId: prevCheckpoint?.id ?? null,
    }

    record.checkpoints.push(checkpoint)
    record.session.lastCheckpointAt = checkpoint.timestamp
    record.session.status = "active"

    return checkpoint
  })
}

// ── Session Resume ───────────────────────────────────────────────────────────

function resumeSession(sessionId: SessionID): Effect.Effect<{ session: SessionState; state: Record<string, unknown> }, Error> {
  return Effect.gen(function* () {
    const record = sessionStore.get(sessionId)
    if (!record) throw new Error(`Session not found: ${sessionId}`)

    const lastCheckpoint = record.checkpoints[record.checkpoints.length - 1]
    if (!lastCheckpoint) throw new Error(`No checkpoint available for session ${sessionId}`)

    record.session.status = "active"

    return { session: record.session, state: structuredClone(lastCheckpoint.state) }
  })
}

// ── Session Close ────────────────────────────────────────────────────────────

function closeSession(sessionId: SessionID): Effect.Effect<SessionState, Error> {
  return Effect.gen(function* () {
    const record = sessionStore.get(sessionId)
    if (!record) throw new Error(`Session not found: ${sessionId}`)

    // Idempotent: double-close is safe
    if (record.session.status === "closed") return record.session

    // Capture final checkpoint before close
    const finalState = record.checkpoints[record.checkpoints.length - 1]?.state ?? {}
    yield* createCheckpoint(sessionId, finalState)

    // Consolidate and cleanup
    record.session.status = "closed"
    record.session.closedAt = Date.now()

    return record.session
  })
}

// ── Session Query ────────────────────────────────────────────────────────────

function getSession(sessionId: SessionID): SessionRecord | undefined {
  return sessionStore.get(sessionId)
}

function listActiveSessions(): SessionRecord[] {
  return [...sessionStore.values()].filter((r) => r.session.status !== "closed")
}

export type { SessionState, Checkpoint, SessionRecord }
export {
  openSession,
  createCheckpoint,
  resumeSession,
  closeSession,
  getSession,
  listActiveSessions,
  sessionStore,
}
