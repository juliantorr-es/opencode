CREATE OR REPLACE VIEW stale_write_refusals AS
SELECT
  i.invocation_id,
  i.session_id,
  e.path,
  e.expected_before_sha256,
  e.before_sha256 AS actual_before_sha256,
  i.started_at AS created_at
FROM tool_invocations i
JOIN tool_file_effects e ON i.invocation_id = e.invocation_id
WHERE i.status = 'refused'
  AND e.expected_before_sha256 IS NOT NULL
  AND e.expected_before_sha256 != e.before_sha256
