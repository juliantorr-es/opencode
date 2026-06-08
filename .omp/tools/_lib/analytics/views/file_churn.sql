CREATE OR REPLACE VIEW file_churn AS
SELECT
  path,
  COUNT(CASE WHEN action = 'read' THEN 1 END) AS read_count,
  COUNT(CASE WHEN action IN ('write', 'create', 'delete') THEN 1 END) AS write_count,
  MAX(CASE WHEN action IN ('write', 'create', 'delete') THEN before_sha256 END) AS last_before_sha256,
  MAX(CASE WHEN action IN ('write', 'create', 'delete') THEN after_sha256 END) AS last_after_sha256,
  MAX(created_at) AS last_touched_at
FROM tool_file_effects
GROUP BY path
