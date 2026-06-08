CREATE OR REPLACE VIEW path_lock_conflicts AS
SELECT DISTINCT
  pl1.path,
  pl1.session_id AS requesting_session_id,
  pl2.session_id AS owning_session_id,
  pl2.lock_id,
  pl1.acquired_at AS conflict_time
FROM path_locks pl1
JOIN path_locks pl2 ON pl1.path = pl2.path
WHERE pl1.lock_id != pl2.lock_id
  AND pl1.status = 'active'
  AND pl2.status = 'active'
  AND (pl1.lock_kind = 'write' OR pl2.lock_kind = 'write')
