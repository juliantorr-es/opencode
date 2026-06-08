-- === PGlite Coordination Store — Core Schema v1 ===
-- All tables use IF NOT EXISTS for idempotent migration.

CREATE TABLE IF NOT EXISTS actors (
  actor_id   TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system', 'unknown')),
  provider   TEXT,
  model      TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  actor_id         TEXT NOT NULL REFERENCES actors(actor_id),
  status           TEXT NOT NULL DEFAULT 'starting'
                     CHECK (status IN ('starting', 'active', 'idle', 'closing', 'closed', 'abandoned')),
  purpose          TEXT,
  started_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at        TEXT
);

CREATE TABLE IF NOT EXISTS work_items (
  work_id    TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'claimed', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
  priority   INTEGER NOT NULL DEFAULT 0,
  created_by_session_id TEXT REFERENCES sessions(session_id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS work_claims (
  claim_id   TEXT PRIMARY KEY,
  work_id    TEXT NOT NULL REFERENCES work_items(work_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'released', 'expired', 'completed')),
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  released_at TEXT
);

-- Only one active claim per work item at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_claims_active
  ON work_claims(work_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS path_locks (
  lock_id    TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  lock_kind  TEXT NOT NULL CHECK (lock_kind IN ('read', 'write')),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  work_id    TEXT REFERENCES work_items(work_id),
  status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'released', 'expired')),
  acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT NOT NULL,
  released_at TEXT
);

-- Only one active write lock per path at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_path_locks_active_write
  ON path_locks(path) WHERE lock_kind = 'write' AND status = 'active';

CREATE TABLE IF NOT EXISTS tool_invocations (
  invocation_id TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  work_id       TEXT REFERENCES work_items(work_id),
  tool_id       TEXT NOT NULL,
  tool_version  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'error', 'refused')),
  risk_level    TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL,
  duration_ms   INTEGER NOT NULL,
  input_sha256  TEXT NOT NULL,
  output_sha256 TEXT,
  receipt_id    TEXT,
  error_code    TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS tool_receipts (
  receipt_id    TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES tool_invocations(invocation_id),
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  tool_id       TEXT NOT NULL,
  tool_version  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'error', 'refused')),
  created_at    TEXT NOT NULL,
  receipt_path  TEXT NOT NULL,
  receipt_sha256 TEXT,
  event_path    TEXT,
  journal_path  TEXT,
  summary       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_file_effects (
  effect_id    TEXT PRIMARY KEY,
  receipt_id   TEXT REFERENCES tool_receipts(receipt_id),
  invocation_id TEXT NOT NULL REFERENCES tool_invocations(invocation_id),
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  path         TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('read', 'write', 'create', 'delete')),
  before_sha256       TEXT,
  expected_before_sha256 TEXT,
  after_sha256        TEXT,
  before_size_bytes   INTEGER,
  after_size_bytes    INTEGER,
  diff_path    TEXT,
  diff_sha256  TEXT
);

CREATE TABLE IF NOT EXISTS write_journals (
  journal_id   TEXT PRIMARY KEY,
  receipt_id   TEXT REFERENCES tool_receipts(receipt_id),
  invocation_id TEXT NOT NULL REFERENCES tool_invocations(invocation_id),
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  status       TEXT NOT NULL DEFAULT 'prepared'
                 CHECK (status IN ('prepared', 'committing', 'committed', 'rollback_needed', 'rolled_back', 'abandoned')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  journal_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS coordination_events (
  event_id    TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES sessions(session_id),
  work_id     TEXT REFERENCES work_items(work_id),
  invocation_id TEXT REFERENCES tool_invocations(invocation_id),
  event_type  TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  checksum    TEXT
);
