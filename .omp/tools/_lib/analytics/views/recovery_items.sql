CREATE OR REPLACE VIEW recovery_items AS
SELECT 'pending_journal' AS category, journal_id AS item_id, 'Pending write journal' AS description, created_at FROM write_journals WHERE status IN ('prepared', 'committing')
UNION ALL
SELECT 'expired_session', session_id, 'Expired session with active locks', last_heartbeat_at FROM sessions WHERE status NOT IN ('closed', 'abandoned') AND last_heartbeat_at < (NOW() - INTERVAL '30 minutes')
UNION ALL
SELECT 'stale_lock', lock_id, 'Active lock past TTL', acquired_at FROM path_locks WHERE status = 'active' AND expires_at < NOW()
UNION ALL
SELECT 'missing_receipt', r.receipt_id, 'Receipt without file artifact', NOW()::TEXT FROM tool_receipts r WHERE NOT EXISTS (SELECT 1 FROM tool_file_effects e WHERE e.receipt_id = r.receipt_id)
