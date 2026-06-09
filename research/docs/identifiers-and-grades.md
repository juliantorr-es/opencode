# Identifiers and Run Grades

## Identifier Model

| Identifier | Format / Rule | Example |
|---|---|---|
| `study_id` | Stable string, kebab-case | `tribunus-gemma4-12b-m1-v1` |
| `optimization_id` | Sequential `OPT-0000` through `OPT-9999`; `OPT-0000` reserved for baseline | `OPT-0042` |
| `experiment_id` | `EXP-` prefix + 4-digit sequential number | `EXP-0001` |
| `workload_id` | Kebab-case stable name | `bos-single-token`, `eight-token-qual` |
| `configuration_id` | SHA-256 of canonical configuration JSON | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `run_id` | UUID v4 | `f47ac10b-58cc-4372-a567-0e02b2c3d479` |
| `trial_index` | 0-based repetition counter within an experiment | `0`, `1`, `2` |
| `artifact_id` | SHA-256 of artifact content (lowercase hex) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `claim_id` | `CLAIM-` prefix + 4-digit sequential number | `CLAIM-0001` |
| `kernel_id` | `KERN-` prefix + 4-digit sequential number | `KERN-0001` |
| `placement_id` | `PLACE-` prefix + 4-digit sequential number | `PLACE-0001` |

## Run Grades

| Grade | Requirements | Supports |
|---|---|---|
| `exploratory` | Dirty tree OK; single repetition; unsupported settings allowed | Cannot support paper claims |
| `controlled` | Committed revision; frozen workload; recognized machine; known model hash; complete provenance; successful validation | Optimization promotion |
| `claim_candidate` | Controlled + preregistered metrics; repetition policy; thermal/power controls; correctness comparison; complete capture | Paper claims |
| `archival` | Claim candidate included in frozen dataset release | Dataset release |
| `legacy_provisional` | Predates evidence plane (the 2751.4s v3 result); marked as NOT authoritative | None |

### Grade Rules

- A grade **cannot** be upgraded after execution when prerequisites were not recorded at run start.
- A run graded below `controlled` provides no evidence for optimization decisions.
- `archival` is a packaging designation applied to claim candidates selected for a frozen dataset release.

### Run Status

Values: `planned`, `admitted`, `running`, `completed`, `cancelled`, `failed`, `killed`, `incomplete`, `invalidated`, `archived`
