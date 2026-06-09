# Tribunus Research Methodology

> Master methodology document governing all performance research conducted under
> the Tribunus evidence framework. This document defines the standards for
> experiment design, evidence handling, provenance, statistical analysis, and
> publication — every element required for performance claims to be credible,
> reproducible, and auditable.

**Document status:** Living standard. Updates require new ADR or revision entry
in changelog.

---

## Table of Contents

1. [Scientific Doctrine](#1-scientific-doctrine)
2. [Evidence Architecture](#2-evidence-architecture)
3. [Identifier Model](#3-identifier-model)
4. [Run Grades](#4-run-grades)
5. [Provenance Requirements by Grade](#5-provenance-requirements-by-grade)
6. [Pipeline Stage Taxonomy](#6-pipeline-stage-taxonomy)
7. [Execution Substrate Taxonomy](#7-execution-substrate-taxonomy)
8. [Instrumentation Modes](#8-instrumentation-modes)
9. [Experiment Design](#9-experiment-design)
10. [Repetition Policy](#10-repetition-policy)
11. [Statistics](#11-statistics)
12. [Promotion Policy](#12-promotion-policy)
13. [Dataset Release](#13-dataset-release)
14. [Reproducibility](#14-reproducibility)
15. [Known Limitations](#15-known-limitations)

---

## 1. Scientific Doctrine

### 1.1 Admissibility of Evidence

No performance claim may be made from:

- **Uncommitted source**: any modification not recorded in version control with
  a known commit hash.
- **Unidentified binary**: a binary whose build provenance (source commit,
  compiler, flags, link-time configuration) cannot be traced.
- **Unsealed image**: a container or VM image whose contents and build recipe
  are not pinned and reproducible.
- **Unspecified workload**: a benchmark or inference task whose exact input,
  parameters, and environment are not recorded.
- **Unknown instrumentation**: measurement code whose overhead, placement, and
  calibration are not disclosed.
- **Incomplete run**: any execution that terminated abnormally (crash, OOM,
  timeout, thermal throttle) without explicit flagging.

### 1.2 Observation Immutability

Raw observations are immutable. They may be annotated, flagged, or excluded
from derived products — but never modified in place. Corrections to recording
errors (e.g. timestamp drift, unit mislabel) must produce a corrected copy
with a provenance link to the original.

### 1.3 Reproducibility of Derived Products

All derived products (summaries, charts, comparisons, claims) must be
reproducible from the raw observation layer by executing documented commands on
a clean checkout of the frozen release tag.

### 1.4 Hypothesis Discipline

Every optimization attempt must begin with a written hypothesis stating:

- The variable being changed.
- The predicted effect and its direction.
- The mechanism believed to cause the effect.
- The minimum effect size considered meaningful.

After execution the hypothesis is classified as:
- **Confirmed**: result consistent with prediction within confidence bounds.
- **Refuted**: result contradicts prediction (effect absent or opposite).
- **Inconclusive**: data insufficient to confirm or refute.
- **Anomalous**: unexpected result requiring investigation before reclassification.

### 1.5 Failed Experiments

Failed experiments — those where the hypothesis is refuted, the measurement
infrastructure malfunctioned, or the run failed to complete — remain in the
dataset. They are flagged but never deleted. A dataset that contains only
successes is inherently suspect.

---

## 2. Evidence Architecture

The evidence plane is organized into four layers, each with distinct
governance and lifecycle rules.

### 2.1 Raw Evidence Layer (Authoritative)

- Immutable records produced by measurement infrastructure.
- Format: JSON Lines (`.jsonl`) with embedded provenance envelope.
- Storage: append-only, content-addressed objects sealed by checksum.
- Single writer: the recorder process. No editing, no post-hoc correction.
- Retention: permanent for archival-grade and claim-candidate runs;
  minimum 90 days for exploratory runs.

### 2.2 Normalized Layer (Parquet, Reproducible)

- Structurally transformed from raw evidence by the normalization pipeline.
- Format: Apache Parquet with defined schemas per evidence type.
- Reproducible: every normalized table can be regenerated from raw evidence
  using a pinned normalizer version and documented parameters.
- Indexed by `(run_id, collection_timestamp, metric_path)`.
- Schema evolution: additive only; breaking changes produce new table
  versions with migration path from old.

### 2.3 Analytical Layer (DuckDB, Disposable)

- Projection, aggregation, and join views over normalized data.
- Implemented as DuckDB views and materialized query results.
- Disposable: always regenerable from the normalized layer.
- No versioning — analytical queries are tools, not artifacts.
- Storage: DuckDB persistent database files, one per dataset release.

### 2.4 Publication Layer (Frozen Releases)

- Curated subset of normalized data, analytical results, and reproduction
  scripts packaged for external distribution.
- Format: compressed archive with manifest, checksums, and license.
- Frozen: each release is a named, tagged, checksummed snapshot.
- Minimal: contains only what is necessary to reproduce stated claims;
  raw evidence is available on request under data-governance terms.

### 2.5 Layer Diagram

```
Raw (.jsonl) ──normalize──> Normalized (.parquet)
                                  │
                                  v
                            Analytical (DuckDB)
                                  │
                                  v
                           Publication (frozen archive)
```

---

## 3. Identifier Model

Every entity in the evidence plane is identified according to the scheme
defined in [`./identifiers-and-grades.md`](./identifiers-and-grades.md).

Key identifiers include:

- **Run ID**: globally unique per execution, embedding substrate, workload,
  optimization, timestamp, and sequence counter.
- **Observation ID**: uniquely identifies a single measurement point within a
  run, incorporating run ID, metric path, and collection index.
- **Dataset ID**: identifies a specific frozen release of the evidence
  collection.
- **Claim ID**: anchors a published claim to the specific subset of evidence
  supporting it.

Refer to the identifiers document for the complete encoding scheme, collision
domain guarantees, and human-readable short-form aliases.

---

## 4. Run Grades

Every run is assigned exactly one grade at registration time. The grade
determines the minimum provenance requirements, retention policy, and the
strength of claims the run may support.

### 4.1 Grade Definitions

| Grade               | Code    | Purpose                                                   |
|---------------------|---------|-----------------------------------------------------------|
| Exploratory         | `E`     | Quick iteration, hypothesis formation, infrastructure QA  |
| Controlled          | `C`     | Systematic single-variable experiment with instrumentation |
| Claim Candidate     | `CC`    | Rigorous measurement supporting a publishable claim       |
| Archival            | `A`     | Long-term reference; highest integrity standards          |
| Legacy Provisional  | `LP`    | Historical data imported from pre-v4 infrastructure       |

### 4.2 Grade Immutability

A run's grade is set at registration and **cannot be upgraded after
execution**. This prevents:

- Cherry-picking successful exploratory runs for post-hoc claims.
- Applying higher-grade provenance requirements retroactively to data that was
  not collected under those conditions.
- Subverting the reproducibility guarantee — exploratory runs target different
  reproducibility standards than archival runs, and pretending otherwise would
  mislead consumers.

A run MAY be downgraded (e.g. archival → controlled) if post-hoc analysis
reveals a provenance gap, but the original grade is preserved in the run
metadata and the downgrade is logged as an annotation.

### 4.3 Grade Selection Guidelines

- **Exploratory**: during development of a new benchmark, workload, or
  instrumentation technique. Expect high variance, incomplete provenance,
  and frequent infrastructure changes.
- **Controlled**: standard experimental evaluation after the methodology is
  stable and instrumentation is calibrated.
- **Claim Candidate**: reserved for the final round of evidence supporting a
  specific performance claim. Requires pre-registered hypothesis and
  analysis plan.
- **Archival**: used for reference measurements of stable baselines and
  canonical configurations. May be re-executed on infrastructure changes.
- **Legacy Provisional**: assigned on import of historical v3 results. These
  runs lack modern provenance fields and are documented accordingly.

---

## 5. Provenance Requirements by Grade

Each provenance field is tagged with the minimum grade that requires it.
Fields marked `—` are not required but may be present.

| Field                       | E    | C    | CC   | A    | LP   |
|-----------------------------|------|------|------|------|------|
| Source commit hash          | opt  | req  | req  | req  | req  |
| Build recipe                | opt  | req  | req  | req  | —    |
| Compiler & flags            | opt  | req  | req  | req  | —    |
| Execution substrate id     | opt  | req  | req  | req  | req  |
| Workload id & version       | —    | req  | req  | req  | req  |
| Workload parameters         | —    | req  | req  | req  | req  |
| Instrumentation manifest    | —    | req  | req  | req  | —    |
| Instrumentation overhead    | —    | —    | req  | req  | —    |
| Thermal state               | —    | —    | req  | req  | —    |
| Page-cache state            | —    | —    | req  | req  | —    |
| Warmup policy               | —    | —    | req  | req  | —    |
| Interleaving order          | —    | —    | req  | req  | —    |
| Repetition count            | —    | req  | req  | req  | —    |
| Hypothesis record           | —    | —    | req  | req  | —    |
| Raw observation checksums   | opt  | opt  | req  | req  | —    |
| Run completion status       | req  | req  | req  | req  | req  |
| Timestamp & time source     | req  | req  | req  | req  | req  |
| Host hardware inventory     | opt  | req  | req  | req  | —    |
| Kernel & OS version         | opt  | req  | req  | req  | req  |
| Scheduler & governor config | —    | req  | req  | req  | —    |
| Adjacent load profile       | —    | —    | req  | req  | —    |
| Dataset release manifest    | —    | —    | (1)  | req  | —    |

- (1): Claim-candidate runs and their supporting controlled runs must be
  traceable to a frozen dataset release, but the release may be created
  specifically for the claim rather than as a general publication.

**Legend:** `req` = required for this grade; `opt` = optional may be present
but is not required; `—` = may be absent without annotation.

---

## 6. Pipeline Stage Taxonomy

The evidence-processing pipeline is divided into stages with defined inputs,
outputs, and verification gates. Refer to
[`./pipeline-stages.md`](./pipeline-stages.md) for the complete stage
catalog.

### 6.1 Stage Categories

- **Capture stages**: raw observation recording, telemetry collection,
  instrumentation framing.
- **Validation stages**: schema conformance, checksum verification,
  completeness checks, anomaly flagging.
- **Transformation stages**: normalization, aggregation, unit conversion,
  timestamp alignment.
- **Analysis stages**: statistical summarization, comparison, visualization.
- **Publication stages**: packaging, metadata generation, archive sealing.

### 6.2 Stage Verification Gates

Every pipeline stage that produces a persisted artifact (raw file, parquet
table, analytical view, release archive) must pass a verification gate
specific to that stage before the artifact is accepted. Gate failure produces
a diagnostic report and blocks the pipeline.

---

## 7. Execution Substrate Taxonomy

An execution substrate is a specific combination of hardware, operating
system, runtime environment, and configuration used to execute benchmark or
inference workloads. The following substrates are defined:

| # | Substrate            | Description                                                       |
|---|----------------------|-------------------------------------------------------------------|
| 1 | bare-metal-native    | Physical hardware, native OS, no virtualization layer             |
| 2 | bare-metal-container | Physical hardware, native OS, workload runs in container runtime   |
| 3 | VM-native            | Virtual machine (hypervisor-backed), native OS within guest        |
| 4 | VM-container         | Virtual machine guest running container runtime                   |
| 5 | container-native     | Container runtime on shared host without explicit VM boundary      |
| 6 | WSL2                 | Windows Subsystem for Linux 2 (Hyper-V backed)                    |
| 7 | macOS-native         | Apple Silicon (M-series) or Intel Mac, native macOS                |
| 8 | macOS-container      | macOS host with Linux VM or Docker Desktop for Mac                 |
| 9 | cloud-instance       | Public cloud compute instance (EC2, GCE, Azure VM) — bare or VM   |
| 10 | serverless           | Function-as-a-service or managed compute with no host access       |
| 11 | embedded             | ARM/RISC-V microcontroller or constrained system-on-chip           |

Substrate identity is part of the run provenance. Comparisons across different
substrates must be explicitly labeled as cross-substrate and are subject to
additional scrutiny for confounding factors.

---

## 8. Instrumentation Modes

Instrumentation is the measurement apparatus interposed between the workload
and the observer. The choice of instrumentation mode determines what can be
measured, with what overhead, and with what confidence.

Refer to [`./instrumentation-overhead.md`](./instrumentation-overhead.md) for:

- Full catalog of supported instrumentation modes.
- Overhead calibration methodology per mode.
- Overhead correction procedures.
- Placement guidelines (in-process, out-of-process, hybrid, hardware
  counter).

Key principles:

- Instrumentation overhead must be quantified and reported for any
  claim-candidate or archival run.
- Overhead must be measured on a no-op workload in the same substrate,
  not estimated from first principles alone.
- Instrumentation must not alter workload behavior (correctness, timing,
  memory access patterns) beyond the quantified overhead.
- If instrumentation cannot be non-invasive, the mode must be downgraded
  to an observation-grade annotation rather than a precision measurement.

---

## 9. Experiment Design

### 9.1 Single-Variable Treatment

The preferred experimental design is a single-variable treatment: one
independent variable is changed between baseline and treatment runs while all
other conditions are held constant. Single-variable designs provide the
strongest causal evidence and are required for claim-candidate grade.

### 9.2 Compound Substitution

When a single-variable change is technically infeasible (e.g. compiler flags
interact, kernel patches require reboot, hardware substitution), a compound
substitution is permitted with explicit documentation of:

- All variables that changed between baseline and treatment.
- The rationale for each change and why it could not be isolated.
- The expected interaction effects and how they are bounded.

Compound substitution runs are ineligible for claim-candidate grade unless
accompanied by a sensitivity analysis that decomposes the individual
contributions.

### 9.3 Interleaved Run Ordering

When comparing two or more configurations, runs must be interleaved rather
than batched:

- Good: `B, T, B, T, B, T` (alternating).
- Better: `B, T, T, B, T, B, B, T` (randomized block).
- Bad: `B, B, B, T, T, T` (confounded with temporal drift).

Interleaving order must be recorded in run metadata.

### 9.4 Thermal Control

- Steady-state temperature must be established before measurements begin.
- Temperature must be recorded before and after each run in the measurement
  window.
- Runs with thermal throttling detected must be flagged and, for
  claim-candidate and archival grades, discarded and re-executed.
- Cooling period between runs must be documented and consistent.

### 9.5 Warmup Policy

- Warmup iterations must be executed before measurement begins.
- Warmup count must be documented and justified.
- Warmup iterations must use the same workload and configuration as measured
  runs — no simplified warmup.
- Detection of warmup completion: coefficient of variation below threshold,
  or fixed count with validation.

### 9.6 Page-Cache State Tracking

- Page-cache state (cold / warm / hot) must be recorded for every run.
- Cache-drop commands must be logged.
- For claim-candidate and archival grades, page-cache state must be verified
  (e.g. via `/proc/meminfo` or equivalent) before measurement begins and
  optionally after.
- Cross-state comparisons (cold vs. warm) must be labeled as such and not
  aggregated.

---

## 10. Repetition Policy

The minimum number of repetitions per cell (baseline/treatment pair) depends
on the run grade and measurement type.

| Scenario                        | Minimum repetitions | Structure               |
|---------------------------------|---------------------|-------------------------|
| Exploratory                     | 1                   | single run              |
| Engineering / controlled        | 3+                  | paired (B,T) × 3        |
| Claim microbenchmark            | 7+                  | paired (B,T) × 7        |
| Claim inference / end-to-end    | 5+                  | paired (B,T) × 5        |
| Full model qualification        | 3+                  | with limitation         |

**Notes:**

- **Paired** means baseline and treatment runs are executed in interleaved
  order within the same session, not serialized across days or reboots.
- **Full model qualification** (e.g. release benchmarking) requires a minimum
  of 3 independent repetitions, each paired, with a disclosure of any
  limitations that prevent stronger inference (e.g. thermal constraints,
  scheduling availability, cost).
- Higher repetition counts are always preferred when budget permits. The
  minimums above are thresholds for admissibility, not targets for
  confidence.

---

## 11. Statistics

### 11.1 Reported Quantities

Every analysis must report:

- **Raw observations**: all individual measurement values, annotated with
  their run ID and collection timestamp. Never summarized-only.
- **Median**: primary measure of central tendency (not mean, to reduce
  sensitivity to skewed distributions and outliers).
- **Minimum and maximum**: range endpoints.
- **Interquartile range (IQR)**: `Q3 — Q1`.
- **Median absolute deviation (MAD)**: robust scale estimator.
- **Percentiles**: 1st, 5th, 25th, 50th, 75th, 95th, 99th.

### 11.2 Paired Differences

When comparing baseline and treatment, the primary unit of analysis is the
paired difference: `treatment_value — baseline_value` within each pair,
preserving the blocking structure of the interleaved design.

### 11.3 Bootstrap Confidence Intervals

- Confidence intervals must be computed via bootstrap resampling of paired
  differences.
- Minimum 1,000 resamples; 10,000+ preferred for publication.
- Method: bias-corrected and accelerated (BCa) percentile bootstrap.
- Confidence level: 95% standard; 99% where multiple comparisons are made
  (Bonferroni correction or equivalent).

### 11.4 Effect Sizes

- Standardized effect size (Cohen's d or equivalent) must be reported for
  claim-candidate comparisons.
- Raw effect size (absolute difference) must also be reported alongside
  standardized.
- Effect size must be accompanied by its own confidence interval.

### 11.5 Outlier Handling

- Outliers must never be silently deleted.
- Outlier detection method must be pre-specified (e.g. MAD-median rule,
  IQR fence).
- Detected outliers must be reported both with and without the outlier in
  the analysis, so readers can assess sensitivity.
- Annotated outliers (e.g. thermal event, page-cache miss) may be excluded
  if the annotation is preserved and the exclusion is justified.

### 11.6 Multiple Comparisons

When multiple metrics, configurations, or time windows are compared
simultaneously, the analysis must account for the multiplicity. Methods:
Bonferroni, Holm–Bonferroni, Benjamini–Hochberg, or permutation test.
The chosen method and number of comparisons must be reported.

---

## 12. Promotion Policy

Promotion is the process by which an optimization moves from experimental
evidence to an accepted performance claim in a dataset release.

### 12.1 Required Gates

Before a claim may be promoted, the supporting evidence must pass:

1. **Correctness gate**: the optimized configuration produces identical output
   (within numerical tolerance) on the benchmark workload.
2. **Safety gate**: no regression in error handling, resource cleanup, or
   signal handling.
3. **Memory gate**: no increase in memory footprint beyond documented
   tradeoff; no new leaks or UAF conditions.
4. **I/O gate**: no unexpected increase in I/O operations or latency
   distribution shift.
5. **Session gate**: no degradation in session establishment, teardown, or
   lifecycle behavior.
6. **Containment gate**: the optimization does not escape its intended scope
   (e.g. component-level optimization does not degrade system-level behavior).

### 12.2 Metric Threshold

The primary metric must exceed a practical threshold, not merely be
statistically significant. A statistically significant 0.1% improvement that
is within measurement noise of the baseline is not promotable.

The threshold must be:

- Pre-declared in the hypothesis record.
- Expressed in absolute terms (e.g. "tail latency at p99 improves by at least
  5%") or relative with justification.
- Supported by the confidence interval: the entire CI (or at minimum the
  lower bound) must lie above the threshold.

### 12.3 Microbenchmark Insufficiency

A microbenchmark result alone is insufficient for promotion. The optimization
must also demonstrate a measurable effect on at least one end-to-end or
realistic workload. Microbenchmarks serve for hypothesis screening; promotion
requires workload-level evidence.

### 12.4 Pre-Declared Tradeoffs

Any tradeoff introduced by the optimization — increased memory, higher p50
latency for lower p99, reduced throughput under contention — must be declared
in the hypothesis record before the confirming runs are executed. Post-hoc
discovery of tradeoffs precludes promotion in the current release cycle; the
optimization may be resubmitted in a subsequent cycle with pre-declared
tradeoffs.

---

## 13. Dataset Release

### 13.1 Release Contents

Every frozen dataset release must include:

| Artifact                    | Required | Notes                                            |
|-----------------------------|----------|--------------------------------------------------|
| Release manifest           | Yes      | Checksums, file listing, schema versions         |
| Evidence schemas           | Yes      | JSON Schema files for all evidence types         |
| Experiment plans           | Yes      | Pre-registered plans for all included runs       |
| Workload definitions       | Yes      | Workload IDs, versions, parameters, inputs       |
| Optimization records       | Yes      | Hypothesis records for all claimed optimizations |
| Claims manifest            | Yes      | All published claims with supporting evidence    |
| Normalized tables          | Yes      | Parquet files per evidence type                  |
| Selected raw evidence      | Yes      | Raw .jsonl for claim-candidate and archival runs |
| Reproduction scripts       | Yes      | Scripts to regenerate all derived products       |
| Documentation              | Yes      | Methodology, identifiers, pipeline docs          |
| Checksums                 | Yes      | Per-file checksums (SHA-256) and aggregate       |
| License                    | Yes      | Usage terms for the dataset                      |
| Reproduction instructions | Yes      | Step-by-step reproduction guide                  |

### 13.2 Privacy Scanning

Before any release containing raw evidence, automated privacy scanning must
detect and redact:

- Hostnames, IP addresses, MAC addresses, fully qualified domain names.
- User names, home directory paths, environment variables with apparent
  secrets or PII.
- File paths that reference real user data or project names not intended for
  disclosure.

Redaction must be documented in the release manifest. Raw evidence containing
unredactable PII must be excluded from public releases.

### 13.3 Missing Artifact Inventory

If any required artifact is missing from a release, the release manifest must
include a `missing_artifacts` section listing each absent artifact with:

- Artifact name and expected location.
- Reason for absence.
- Whether the absence affects reproducibility of any claim.
- Plan for including in a future release.

---

## 14. Reproducibility

### 14.1 Full Reproduction

A full reproduction from a clean checkout of the frozen release tag must
produce identical derived products (checksum-verifiable). The procedure:

```shell
# 1. Clean checkout
git checkout tags/dataset-YYYY-MM-DD-N

# 2. Verify environment
./research/scripts/check-environment.sh

# 3. Build benchmarks
./research/scripts/build.sh

# 4. Run reproducibility check (validates against frozen data)
./research/scripts/reproduce.sh  --check

# 5. Regenerate derived products
./research/scripts/reproduce.sh --regenerate

# 6. Verify checksums match release manifest
sha256sum --check release/manifest.sha256
```

### 14.2 Partial Reproduction

Reproducing a specific claim from normalized data (without re-execution):

```shell
# 1. Extract release archive
tar xzf dataset-YYYY-MM-DD-N.tar.gz

# 2. Load normalized data into DuckDB
./research/scripts/load-normalized.sh dataset-YYYY-MM-DD-N

# 3. Reproduce claim tables
./research/scripts/reproduce-claim.sh CLAIM_ID
```

### 14.3 Environment Checks

The `check-environment.sh` script verifies:

- OS and kernel version match release manifest.
- Required tools are installed with compatible versions.
- Hardware inventory matches (same CPU, memory, storage characteristics).
- Time synchronization source is available and accurate.
- No unexpected background load (daemons, cron, scheduled tasks).

### 14.4 Known Non-Reproducible Factors

The following factors may cause bitwise divergence between reproduction runs
even with identical inputs:

- CPU thermal state drift across independent sessions.
- DRAM row-hammer refresh effects on adjacent cells.
- ASLR and other kernel randomization.
- Scheduler decisions in non-isolated environments.

These divergences are expected and acceptable as long as summary statistics
agree within confidence intervals.

---

## 15. Known Limitations

### 15.1 Current Evidence Plane (v1)

The v1 evidence plane has the following limitations:

- **Single-host scope**: all current measurements are single-machine. No
  distributed or multi-tenant coordination is measured.
- **No network instrumentation**: network latency, bandwidth, and protocol
  behavior are not instrumented in v1.
- **CPU-only**: GPU, NPU, and other accelerator measurements are not yet
  supported in the standardized pipeline.
- **User-space focus**: kernel-bypass, io_uring, and eBPF-based
  instrumentation are not yet integrated.
- **Static workload definitions**: workloads are defined at release time and
  cannot be dynamically composed.
- **No real-time guarantees**: the measurement infrastructure is not
  designed for hard real-time or deterministic latency bounds.

### 15.2 What Can Be Claimed

Given v1 limitations, claims may be made about:

- CPU-bound throughput under controlled scheduling.
- Memory bandwidth and access pattern effects.
- Latency percentiles (p50, p95, p99, p99.9) under defined load.
- Instruction-level efficiency changes (IPC, branch mispredictions, cache
  misses).
- Runtime comparison of compiler flags, library versions, and code
  transformations.
- Optimization effects reproducible on identical single-machine hardware.

### 15.3 What Cannot Be Claimed (v1)

Claims that are NOT supported by v1 evidence:

- End-to-end system latency under network load.
- Multi-node throughput scaling.
- GPU or accelerator performance (unless measured outside the standard
  pipeline and explicitly labeled as supplementary).
- Real-time or hard-latency bounds.
- Power efficiency on non-CPU components (memory, network, storage).
- Performance under adversarial scheduling or resource contention.

### 15.4 Cross-Grade Limitations

- Legacy provisional records carry limited provenance; they should be used
  only for historical trend context, never as primary claim evidence.
- Exploratory runs carry no reproducibility guarantee; they should not be
  cited as evidence for published claims.
- Claim-candidate evidence is peer-review quality but not external-audit
  quality — archival grade is required for claims intended for regulatory or
  contractual use.

---

## Appendix A: Document Changelog

| Date       | Author | Change                                            |
|------------|--------|---------------------------------------------------|
| 2026-06-08 | —      | Initial version — all 15 sections as defined.     |

## Appendix B: Related Documents

- [`./identifiers-and-grades.md`](./identifiers-and-grades.md) — Identifier
  encoding and run grade definitions.
- [`./pipeline-stages.md`](./pipeline-stages.md) — Pipeline stage catalog and
  gate specifications.
- [`./instrumentation-overhead.md`](./instrumentation-overhead.md) —
  Instrumentation mode catalog and overhead calibration.
- Evidence schemas (JSON Schema): `schemas/` directory at release root.
- Experiment plans: `plans/` directory at release root.
