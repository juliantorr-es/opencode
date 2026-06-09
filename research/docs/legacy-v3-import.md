# Legacy V3 Import — `legacy_provisional` Result

## Overview

This document records the **sole surviving v3 baseline run** that predates the formal evidence plane. It is retained for historical reference but carries no authoritative weight for optimization decisions.

## Run Identity

| Field | Value |
|---|---|
| `run_id` | `placeholder-uuid` (auto-generated; not recorded at run time) |
| Grade | `legacy_provisional` |
| Date | 2026-06-08 |
| Source | `real_checkpoint_full_model_gate` test (cargo test --ignored) |
| Duration | 2751.4 seconds (45.86 min) |

## Compilation Phase

| Metric | Value |
|---|---|
| Duration | 2045 seconds |
| Segments compiled | 49 |
| Tensors allocated | 1180 |
| Payload size | 12.4 GB |

## Execution Phase

| Metric | Value |
|---|---|
| Duration | 94.4 seconds |
| Layers executed | 48 |

## Evidence Snapshot

| Metric | Value |
|---|---|
| Image hash | `d042df1e4062a53e3a003af4e2e8c714924fcf19f03b7cf0dd5f67293355d924` |
| Output token count | 189,773 |
| Handle count (start → peak → end) | 0 → peak → 0 (no leaks) |
| All layers finite | `true` |

## Known Missing Evidence

This result predates the formal evidence plane. The following were NOT captured:

- **Run manifest** — no structured metadata file recording the run configuration
- **Raw event journal** — no event stream of compile/execute lifecycle transitions
- **Provenance** — no commit SHA, lockfile digests, or binary hashes recorded at run start
- **Machine profile** — no anon ID, chip details, thermal state, or throttling events
- **Environment variables** — no snapshot of `env` at run time
- **Instrumented file I/O** — no record of reads/writes during execution
- **Per-layer KV state** — no per-layer activation or cache state captures
- **Formal finalization** — no checklist closure or sign-off artifact

## Historical Context

This result was extracted from a single `cargo test --ignored` run of the `real_checkpoint_full_model_gate` test. It was the only complete v3 baseline measurement available at the time of evidence-plane introduction.

## Caveat

> This result MAY appear in historical charts and discussion but **CANNOT** become the authoritative Experiment Zero (`EXP-0000`) until all missing evidence is recollected under the evidence-plane protocol. Any optimization claim derived from this result must be re-validated against a properly instrumented run.

## Authority Chain

```
legacy_provisional ──→ [not usable for optimization evidence]
                         │
                         └── requires full recollection under evidence plane
                              to become controlled / claim_candidate
```
