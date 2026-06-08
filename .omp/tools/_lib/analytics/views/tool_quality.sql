CREATE OR REPLACE VIEW tool_quality AS
SELECT
  tool_id,
  COUNT(*) AS total_invocations,
  COUNT(CASE WHEN status = 'ok' THEN 1 END) AS ok_count,
  COUNT(CASE WHEN status = 'refused' THEN 1 END) AS refused_count,
  COUNT(CASE WHEN status = 'error' THEN 1 END) AS error_count,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median_duration_ms
FROM tool_invocations
GROUP BY tool_id
