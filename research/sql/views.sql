-- ============================================================================
-- Analytical Views — compute-research evidence plane
-- ============================================================================
-- These views sit atop the normalized tables emitted by the normalize module
-- (runs, stage_events, memory_samples, token_metrics, projection_stage_events,
-- correctness_checkpoints).
--
-- DuckDB-compatible SQL.  Register by running:
--   .read research/sql/views.sql
-- after loading data with the load.sql script produced by buildDuckDb().
-- ============================================================================

-- ── 1. Valid claim-grade runs ───────────────────────────────────────────────
-- Runs graded as "claim_candidate" that completed successfully.
CREATE OR REPLACE VIEW valid_claim_runs AS
SELECT
  run_id,
  experiment_id,
  optimization_id,
  trial_index,
  start_time,
  end_time,
  source_revision,
  workload_id,
  machine_anon_id,
  machine_chip,
  machine_memory,
  model_image_hash,
  instrumentation_mode,
  page_cache_class,
  power_class,
  thermal_class,
  event_count,
  stage_event_count,
  memory_sample_count,
  token_metric_count,
  projection_stage_count,
  checkpoint_count
FROM runs
WHERE run_grade = 'claim_candidate'
  AND status = 'completed';

-- ── 2. Baseline–treatment comparison pairs ──────────────────────────────────
-- Joins runs to their experiment plans to pair baseline and treatment
-- configurations for the same study/optimization.
CREATE OR REPLACE VIEW comparison_pairs AS
SELECT
  b.run_id                                              AS baseline_run_id,
  t.run_id                                              AS treatment_run_id,
  COALESCE(b.experiment_id, t.experiment_id)            AS experiment_id,
  COALESCE(b.optimization_id, t.optimization_id)        AS optimization_id,
  b.workload_id                                         AS workload_id,
  b.machine_anon_id                                     AS machine_id,
  b.run_grade                                           AS baseline_grade,
  t.run_grade                                           AS treatment_grade,
  b.start_time                                          AS baseline_start,
  t.start_time                                          AS treatment_start,
  b.event_count                                         AS baseline_events,
  t.event_count                                         AS treatment_events,
  b.checkpoint_count                                    AS baseline_checkpoints,
  t.checkpoint_count                                    AS treatment_checkpoints
FROM runs b
INNER JOIN runs t
  ON b.workload_id = t.workload_id
 AND b.machine_anon_id = t.machine_anon_id
 AND (b.experiment_id = t.experiment_id OR b.optimization_id = t.optimization_id)
 AND b.run_id <> t.run_id
WHERE b.run_grade IN ('claim_candidate', 'controlled')
  AND t.run_grade IN ('claim_candidate', 'controlled')
  AND b.status = 'completed'
  AND t.status = 'completed';

-- ── 3. Stage execution time by layer ────────────────────────────────────────
-- Aggregates per-layer stage duration across runs.
CREATE OR REPLACE VIEW stage_share_by_layer AS
SELECT
  run_id,
  stage_id,
  layer_index,
  substrate_id,
  COUNT(*)                                              AS event_count,
  SUM(COALESCE(
    CAST(JSON_EXTRACT(measurements, '$.eval_ns') AS BIGINT), 0
  ))                                                    AS total_eval_ns,
  SUM(COALESCE(
    CAST(JSON_EXTRACT(measurements, '$.eval_ns') AS BIGINT), 0
  )) / NULLIF(SUM(SUM(COALESCE(
    CAST(JSON_EXTRACT(measurements, '$.eval_ns') AS BIGINT), 0
  ))) OVER (PARTITION BY run_id, stage_id), 0) * 100.0 AS share_pct
FROM stage_events
WHERE stage_status = 'completed'
GROUP BY run_id, stage_id, layer_index, substrate_id;

-- ── 4. Token latency (decode step timing) ───────────────────────────────────
-- Computes per-token latency as the difference in monotonic_ns between
-- consecutive token-sample events within a run.
CREATE OR REPLACE VIEW token_latency AS
SELECT
  run_id,
  token_index,
  token_id,
  monotonic_ns                                         AS start_ns,
  LAG(monotonic_ns) OVER (
    PARTITION BY run_id
    ORDER BY sequence_number
  )                                                     AS prev_ns,
  CASE
    WHEN LAG(monotonic_ns) OVER (
      PARTITION BY run_id
      ORDER BY sequence_number
    ) IS NOT NULL
    THEN monotonic_ns - LAG(monotonic_ns) OVER (
      PARTITION BY run_id
      ORDER BY sequence_number
    )
    ELSE NULL
  END                                                   AS latency_ns,
  decode_ns,
  attention_ns,
  mlp_ns,
  norm_ns,
  sample_ns,
  (decode_ns + attention_ns + mlp_ns + norm_ns + sample_ns)
                                                        AS accounted_ns,
  CASE
    WHEN decode_ns > 0 THEN decode_ns / NULLIF(decode_ns + attention_ns + mlp_ns + norm_ns + sample_ns, 0) * 100.0
    ELSE NULL
  END                                                   AS decode_share_pct
FROM token_metrics
ORDER BY run_id, sequence_number;

-- ── 5. Bottleneck migration across substrates ───────────────────────────────
-- Identifies stages whose execution substrate shifted between runs of the
-- same experiment, indicating a bottleneck-mitigation re-route.
CREATE OR REPLACE VIEW bottleneck_migration AS
WITH stage_substrate AS (
  SELECT DISTINCT
    run_id,
    stage_id,
    layer_index,
    substrate_id
  FROM stage_events
  WHERE stage_status = 'completed'
),
paired AS (
  SELECT
    a.run_id                                            AS run_a,
    b.run_id                                            AS run_b,
    a.stage_id,
    a.layer_index,
    a.substrate_id                                      AS substrate_a,
    b.substrate_id                                      AS substrate_b,
    CASE
      WHEN a.substrate_id = b.substrate_id THEN 'stable'
      ELSE 'migrated'
    END                                                 AS migration_state
  FROM stage_substrate a
  INNER JOIN stage_substrate b
    ON a.stage_id = b.stage_id
   AND a.layer_index = b.layer_index
   AND a.run_id < b.run_id
)
SELECT
  stage_id,
  layer_index,
  migration_state,
  COUNT(DISTINCT run_a || '-' || run_b)                 AS pair_count,
  COUNT(*)                                              AS instance_count,
  LIST(DISTINCT substrate_a)                            AS substrates_from,
  LIST(DISTINCT substrate_b)                            AS substrates_to
FROM paired
GROUP BY stage_id, layer_index, migration_state
ORDER BY stage_id, layer_index, migration_state;

-- ── 6. Correctness summary per run ──────────────────────────────────────────
-- Aggregates checkpoint pass/fail rates per run, including tensor-level
-- error statistics.
CREATE OR REPLACE VIEW correctness_summary AS
SELECT
  run_id,
  COUNT(*)                                              AS total_checkpoints,
  SUM(CASE WHEN passed THEN 1 ELSE 0 END)               AS passed_checkpoints,
  SUM(CASE WHEN NOT passed THEN 1 ELSE 0 END)           AS failed_checkpoints,
  CAST(SUM(CASE WHEN passed THEN 1 ELSE 0 END) AS DOUBLE)
    / NULLIF(COUNT(*), 0) * 100.0                       AS pass_rate_pct,
  MAX(max_abs_error)                                    AS max_abs_error_overall,
  AVG(mean_abs_error)                                   AS avg_abs_error,
  MAX(max_rel_error)                                    AS max_rel_error_overall,
  AVG(mean_rel_error)                                   AS avg_rel_error,
  AVG(cosine_similarity)                                AS avg_cosine_similarity,
  MIN(cosine_similarity)                                AS min_cosine_similarity
FROM correctness_checkpoints
GROUP BY run_id
ORDER BY run_id;

-- ── 7. Memory pressure profile ─────────────────────────────────────────────
-- Provides per-run memory usage summary from memory_sample events.
CREATE OR REPLACE VIEW memory_pressure_profile AS
SELECT
  run_id,
  stage_id,
  layer_index,
  COUNT(*)                                              AS sample_count,
  AVG(resident_bytes)                                   AS avg_resident_bytes,
  MAX(resident_bytes)                                   AS peak_resident_bytes,
  AVG(wired_bytes)                                      AS avg_wired_bytes,
  MAX(wired_bytes)                                      AS peak_wired_bytes,
  AVG(active_bytes)                                     AS avg_active_bytes,
  MAX(active_bytes)                                     AS peak_active_bytes,
  AVG(compressed_bytes)                                 AS avg_compressed_bytes,
  MAX(compressed_bytes)                                 AS peak_compressed_bytes
FROM memory_samples
GROUP BY run_id, stage_id, layer_index
ORDER BY run_id, layer_index;
