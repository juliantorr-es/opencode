-- === PGlite Coordination Store — Performance Indexes v2 ===
-- All indexes use IF NOT EXISTS for idempotent migration.

CREATE INDEX IF NOT EXISTS idx_sessions_status          ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_last_heartbeat  ON sessions(last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_path_locks_path          ON path_locks(path);
CREATE INDEX IF NOT EXISTS idx_path_locks_session       ON path_locks(session_id);
CREATE INDEX IF NOT EXISTS idx_path_locks_status        ON path_locks(status);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_session ON tool_invocations(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_tool    ON tool_invocations(tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_file_effects_path   ON tool_file_effects(path);
CREATE INDEX IF NOT EXISTS idx_tool_file_effects_receipt ON tool_file_effects(receipt_id);
CREATE INDEX IF NOT EXISTS idx_write_journals_status    ON write_journals(status);
CREATE INDEX IF NOT EXISTS idx_coordination_events_session ON coordination_events(session_id);
CREATE INDEX IF NOT EXISTS idx_coordination_events_type  ON coordination_events(event_type);
