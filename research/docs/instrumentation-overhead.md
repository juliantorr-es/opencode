# Instrumentation Overhead Qualification

> Phase 8, Evidence Plane v1 — Tribunus Inference Research

**Version:** 1.0.0  
**Status:** Methodology defined  

This document defines the procedure for measuring and qualifying the overhead introduced by each instrumentation mode. Overhead values are used to:

- Attribute measured latency differences to instrumentation, not the optimisation under test
- Select the appropriate mode for each class of experiment
- Validate that optimisation comparisons are apples-to-apples on instrumentation level

---

## Instrumentation Modes

Four modes control the breadth and depth of instrumentation attached to each run. Each mode is a superset of the previous.

| Mode | Purpose | Captures |
|------|---------|----------|
| `off` | Safety-critical metrics only, no research dataset produced | Lifecycle events (launch, crash, completion), OOM/error signals, basic exit code |
| `minimal` | Optimisation screening, regression detection | Request timing (wall-clock), output token count, terminal outcome, RSS peak, MLX peak, basic provenance (model hash, commit, machine) |
| `research_standard` | Authoritative optimisation baseline, controlled comparison | Model-open details (layer count, head count, d_model), per-phase timing (prefill vs decode breakdown), per-layer timing (attention, MLP, norm), KV cache metrics (hit rate, eviction count, resident size), mapping metrics (segment count, tensor count), file I/O activity (open count, byte volume), memory samples (snapshot every N tokens), correctness checkpoints (deterministic-trace compare after decode step) |
| `research_deep` | Diagnosis, kernel studies, memory-pressure analysis | Per-operation/per-kernel events (individual matmul launch, softmax invocation, norm call), launch metadata (grid size, threadgroup size, pipeline flush), materialization details (weight load vs cache, buffer reuse count), transfer boundaries (device↔host, device↔device every byte count), detailed synchronization (wait duration, barrier count, stream contention) |

### Mode Selection Rules

- `research_standard` is the **default** mode for all controlled optimisation experiments. Headline performance figures MUST use this mode.
- `minimal` MAY be used for early screening (large sweep of candidates) where per-run overhead is critical. Any candidate identified via `minimal` MUST be re-run at `research_standard` before promotion.
- `research_deep` MUST NOT be used for headline performance or optimisation comparison. It is reserved for diagnosis and kernel studies and MAY be used for comparative analysis only when overhead is proven negligible for the target metric (see § Overhead Proven Negligible).
- `off` is used only for the overhead baseline measurement itself. It does not produce a run dataset and cannot support claims.

---

## Measurement Procedure

### Workload

Use the `bos-single-token` workload (defined in the workload taxonomy). This workload executes a single decode step on the beginning-of-sequence token with minimal context — the shortest possible execution time, making instrumentation overhead the most visible as a fraction of total runtime.

### Iterations

1. Run **3 iterations** of each instrumentation mode on identical hardware, software, and thermal state.
2. The **first iteration** is discarded as warmup (JIT compilation, cache fill, thermal steady-state).
3. Iterations 2 and 3 are retained. If their latency differs by more than 5% of the smaller value, run a fourth iteration and discard the outlier.

### Measurement Regimen

For each retained iteration, capture:

| Metric | Source | Unit |
|--------|--------|------|
| Wall-clock latency | Request-level clock (monotonic, ns resolution) | ms |
| Added wall-clock latency | mode_latency − off_latency (computed across co-located runs) | ms |
| Peak RSS | Process-level `maxrss` via `getrusage(RUSAGE_SELF)` | MB |
| Added process RSS | mode_rss − off_rss | MB |
| MLX peak memory | `mlx.metal.metal_peak_memory()` or equivalent runtime query | MB |
| IPC trace batch frame bytes | Trace bus: total byte payload of all batch frames written to trace ring | bytes |
| Event count | Total instrumentation events emitted across run duration | count |
| Artifact volume | Total bytes written to run directory (trace, metrics, snapshots, checkpoints) | bytes |

### Computation

```
overhead_percentage = (mode_latency − off_latency) / off_latency × 100
```

Report overhead separately for each instrumented mode.

---

## Rules

### Identical Instrumentation

Controlled comparisons MUST use the **identical** instrumentation mode for every run in the comparison. Mixing modes within a comparison invalidates the result — latency differences between modes are instrumentation overhead, not optimisation effect.

### Baseline Mode

The authoritative optimisation baseline uses `research_standard` mode:

- The unoptimised run against which an optimisation is compared MUST be recorded at `research_standard`.
- The optimised run MUST also use `research_standard`.
- An optimisation promoted from a `minimal`-mode screening must be re-baselined at `research_standard` before promotion.

### Headline Performance

Headline performance figures (claims, comparisons, marketing, publication) MUST NOT compare an uninstrumented (`off`) baseline with a deeply instrumented (`research_deep` or `research_standard`) treatment. The instrumentation difference is a confound.

### Research Deep Usage

`research_deep` is for diagnosis and kernel studies unless **overhead proven negligible** for the target metric.

#### Overhead Proven Negligible

A mode's overhead is proven negligible for a given metric when all of the following hold for the same workload and hardware:

1. The 95th percentile of added wall-clock latency in that mode is ≤ 2% of the baseline (`off`) latency.
2. The added peak RSS is ≤ 5% of the baseline RSS.
3. The artifact volume is ≤ 1 GiB (avoids I/O interference).
4. The three preconditions are re-validated after any hardware, software, or runtime change that could materially alter instrumentation cost.

When these conditions are met, the mode MAY be used for comparative analysis on the validated metric. Research deep overhead varies by workload; the workload used for validation must match the workload used in the comparison.

### Fixed Mode Within Comparison

Once selected for a comparison, the instrumentation mode MUST remain fixed across all runs in that comparison. Switching modes between baseline and treatment, or between iterations of the same experiment, invalidates the result.

### Run Grades

Overhead measurements themselves are `controlled` grade or above. A table of per-mode overhead values validated on the reference machine qualifies as a `controlled` support artifact.

---

## Expected Results

The table below is a template to be populated after measurement on each reference machine.

### Overhead Summary

| Mode | Wall-clock added (ms) | Overhead % | RSS added (MB) | MLX peak added (MB) | IPC bytes | Event count | Artifact volume |
|------|----------------------|------------|----------------|---------------------|-----------|-------------|-----------------|
| `off` | — | — | — | — | — | — | — |
| `minimal` | | | | | | | |
| `research_standard` | | | | | | | |
| `research_deep` | | | | | | | |

### Per-Mode Validation

| Mode | Overhead % ≤ 2% (latency) | RSS added ≤ 5% | Artifact ≤ 1 GiB | Negligibility status |
|------|--------------------------|----------------|------------------|----------------------|
| `minimal` | | | | |
| `research_standard` | | | | |
| `research_deep` | | | | |

---

## Revision History

| Date | Version | Change |
|------|---------|--------|
| 2026-06-08 | 1.0.0 | Initial methodology definition |
