CREATE OR REPLACE VIEW session_summary AS
SELECT
  s.session_id,
  s.actor_id,
  s.status,
  COUNT(i.invocation_id) AS invocation_count,
  COUNT(CASE WHEN e.action IN ('write', 'create', 'delete') THEN 1 END) AS write_count,
  COUNT(CASE WHEN e.action = 'read' THEN 1 END) AS read_count,
  COUNT(CASE WHEN i.status = 'refused' THEN 1 END) AS refusal_count,
  COUNT(CASE WHEN i.status = 'error' THEN 1 END) AS error_count,
  MIN(i.started_at) AS first_activity,
  MAX(i.finished_at) AS last_activity
FROM sessions s
LEFT JOIN tool_invocations i ON s.session_id = i.session_id
LEFT JOIN tool_file_effects e ON i.invocation_id = e.invocation_id
GROUP BY s.session_id, s.actor_id, s.status
