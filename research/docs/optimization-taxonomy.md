# Optimization Taxonomy

> Phase 0, Evidence Plane v1 — Tribunus Inference Research

This document defines the taxonomies, classification rules, and lifecycle invariants governing every `OptimizationRecord` in the Tribunus Inference Research Evidence Plane.

---

## Subsystems

Each optimization targets exactly one subsystem. The subsystem categorises *where* in the inference stack the change lives.

| Subsystem | Description |
|---|---|
| `model_open` | The model definition, architecture graph, and weight loading path. Optimisations here change the topology, parameter layout, or initialisation — for example, quantising weights at load time or fusing `LayerNorm` into preceding matrices. |
| `prefill` | The prompt-processing phase (compute-bound, runs once per sequence). Targets context encoding: flash-attention variants, block-sparse matmuls, or fused QKV projections. |
| `decode` | The token-generation phase (memory-bandwidth-bound, runs autoregressively). Targets kv-cache reads, single-token matmuls, and output projection. |
| `kv_cache` | The key-value cache data structure, its memory format, eviction policy, and storage tier. Covers paged attention, indirect indexing, windowed/rolling caches, and offload strategies. |
| `attention` | The attention mechanism itself — independent of whether it runs during prefill or decode. Includes custom kernels, attention sparsity, ALiBi/RoPE integration, and multi-query/grouped-query attention layouts. |
| `mlp` | The feed-forward / gated-MLP blocks (SwiGLU, etc.). Optimisations target activation recomputation, fused hidden-dimension matmuls, or selective expert loading for MoE. |
| `embedding` | Token and position embedding lookup, including vocabulary projection and its transpose. Covers embedding sharding, mixed-precision storage, and fused embedding + softmax. |
| `epilogue` | Post-transformer-layer operations: output logit projection, softmax, sampling, top-k filtering, and repetition penalty. Target of kernel fusion to avoid materialising the full logit buffer. |
| `storage` | Persistent weight and cache storage: model shard files, memory-mapped I/O, streaming load from disk, checkpoint format, and weight compression. |
| `graph_scheduling` | The computation graph compiler / scheduler: operator fusion decisions, memory planning, async dispatch, and kernel launch ordering. Optimisations here are at the Metal Performance Shader Graph or MLX graph level. |
| `control_plane` | Orchestration, batching, load shedding, continuous batching policy, preemption, and request scheduling. Software-architecture changes to the runtime itself, not to individual kernels. |

---

## Deployability Classes

The deployability class describes the *surface* where the optimisation runs and the *risk tier* it occupies. It determines what testing, review, and rollout gates apply.

| Class | Description |
|---|---|
| `generic_mlx` | Pure MLX graph optimisation — runs on any MLX backend (Apple Silicon, Metal, CPU fallback). No custom Metal shaders. Lowest risk; tested by standard MLX numerics. |
| `tribunus_custom_mlx` | Custom MLX primitive or MLX-level kernel written for Tribunus. Still uses MLX's compilation path but adds project-specific operator implementations. Requires additional validation that MLX graph invariants are preserved. |
| `tribunus_metal` | Custom Metal Performance Shader or direct Metal compute pipeline written for Tribunus. Bypasses MLX graph abstraction. Requires GPU correctness gates and memory-safety validation. |
| `coreml_placement` | Placement of a subgraph onto Apple's CoreML / ANE runtime via `coremltools`. Involves model export, profiling, and fallback logic. Testing requires real-device ANE profiling. |
| `public_ane` | Optimisation exploiting documented ANE hardware capabilities via public APIs (ANE on M-series). Uses publicly documented interfaces; risk is hardware-specific behaviour differences. |
| `orion_research` | Experimental or explorative optimisation in the Orion research subsystem. Not yet on a promotion path to production. May use unstable APIs, unverified heuristics, or prototype hardware paths. |
| `cpu_accelerate` | Optimisation targeting the Accelerate framework (BNNS, vDSP, BLAS) or direct CPU dispatch. Relevant for prefill offload, embedding lookup, or fallback paths. Testing on both Intel and Apple Silicon required. |
| `kv_architecture` | Optimisation that changes the K/V cache data structure, memory layout, or eviction / windowing strategy. Cross-cutting: affects prefill KV write, decode KV read, memory pressure, and PagedAttention integration. Highest blast radius within inference. |
| `storage_change` | Optimisation that changes on-disk or memory-mapped weight storage format, sharding layout, streaming protocol, or checkpoint schema. Risk of silent data corruption if checksums or alignment invariants are violated. |
| `graph_scheduling` | Optimisation to the MLX / MPS graph compiler's scheduling, fusion, or memory planning heuristics. Primarily affects latency stability and peak memory. Regressions are hard to attribute to a single change. |
| `control_plane` | Runtime orchestration change: batching policy, preemption strategy, continuous batching window sizing, load-shedding thresholds. Validated through workload simulation, not kernel numerics. |

---

## Result Classifications

Every optimisation record must be assigned exactly one result classification after all experiments have been conducted and reviewed.

| Classification | Meaning |
|---|---|
| `promoted` | The optimisation met its quantitative target, passed all correctness and safety gates, and has been deployed to the target deployability class. The record serves as the permanent audit trail. |
| `rejected` | Experiments conclusively showed the optimisation does not work — either it failed to meet its hypothesised effect, caused regressions that could not be mitigated, or introduced unacceptable correctness or safety issues. A rejected record is not deleted; it remains to prevent repeating the same approach. |
| `deferred` | The optimisation showed promise but is not ready for promotion now. The bottleneck hypothesis may require more profiling, the implementation may depend on an upcoming hardware or software dependency, or higher-priority work intervened. A deferred record may be revisited under a new experiment cycle. |
| `research_only` | The optimisation was evaluated under research or prototype conditions only (e.g., in the Orion subsystem, a synthetic benchmark, or a non-production Metal environment). It produced interesting data but is not on a commitment path to production. The findings remain available for cross-referencing. |
| `inconclusive` | The experiments did not produce sufficient evidence to classify the optimisation. Common causes: noisy benchmarking infrastructure, incomplete coverage of relevant deployment scenarios, or a flawed experiment design. An inconclusive record should specify what additional evidence is needed. |

### Negative Results Are Immortal

A record classified as `rejected` is **never deleted**. It remains in the evidence plane permanently for the following reasons:

- **Prevents repeated work.** A rejected optimisation with an attached hypothesis and experimental data is the strongest signal that the same approach should not be re-tried without new evidence.
- **Preserves experimental context.** The bottleneck hypothesis, experiment configuration, and observed regressions are valuable when similar approaches are proposed later.
- **Audit trail.** Every optimisation decision, including the decision not to deploy, is part of the public record for the inference stack.

Rejected records may be revisited only if:
1. A materially different implementation is proposed (not a re-try of the same approach), or
2. The underlying hardware or software platform has changed in a way that invalidates the original experimental results.

In either case, a new `optimization_id` is minted and the new record references the old one in its `final_decision` field.

---

## Lifecycle Invariants

### Written Hypothesis Required

Every optimisation begins with a written hypothesis. Before any code is written, any experiment is run, or any kernel is profiled, the optimisation record MUST contain:

- A clearly stated `bottleneck_hypothesis`
- The `expected_mechanism` by which the change addresses the bottleneck
- A quantitative `expected_primary_effect`

An optimisation record with an empty or placeholder hypothesis is invalid. The hypothesis is the contract that the experiment is designed to test.

### Classification Required

Every optimisation ends with a classification. After the experimental evidence has been collected and reviewed, the record MUST be assigned exactly one of the five `result_classification` values. A record may remain unclassified only temporarily during the experiment cycle; at any formal review boundary (e.g., experiment closeout, milestone, release cut), every open optimisation record without a classification must be explicitly discussed and classified — even if that classification is `inconclusive`.

### Immutability of Key Fields

Once a record has been classified, the following fields become immutable (they may be supplemented but not replaced):

- `optimization_id`
- `subsystem`
- `bottleneck_hypothesis`
- `expected_mechanism`
- `expected_primary_effect`
- `experiment_ids`

The `final_decision` and `result_classification` may be updated only when new experimental evidence rises to the level of a formal re-evaluation (see *Negative Results Are Immortal* above).

### Ordering

The canonical ordering for `OPT-NNNN` identifiers is chronological by `created_at`. No semantic meaning is encoded in the numeric portion beyond ordering.

---

## Field Quick Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `optimization_id` | `string` (OPT-NNNN) | yes | Unique identifier |
| `title` | `string` | yes | Short description |
| `subsystem` | `enum` (11 values) | yes | Inference subsystem |
| `target_pipeline` | `[string]` | yes | Affected pipeline stage IDs |
| `current_implementation` | `string` | yes | Current production implementation |
| `proposed_replacement` | `string` | yes | Proposed replacement technique |
| `bottleneck_hypothesis` | `string` | yes | Why this should help |
| `expected_mechanism` | `string` | yes | Causal mechanism |
| `expected_primary_effect` | `string` | yes | Quantitative expectation |
| `possible_regressions` | `string` | yes | What could go wrong |
| `source_commits` | `[string]` | yes | Implementation commit SHAs |
| `feature_flags` | `[string]` | yes | Runtime feature flag identifiers |
| `fallback_path` | `string` | yes | How the runtime behaves without the optimisation |
| `deployability_class` | `enum` (11 values) | yes | Deployment surface / risk tier |
| `correctness_gates` | `[string]` | yes | Required correctness gate names |
| `safety_gates` | `[string]` | yes | Required safety gate names |
| `experiment_ids` | `[string]` (EXP-NNNN) | yes | Associated experiment IDs |
| `result_classification` | `enum` (5 values) | yes | Final outcome classification |
| `final_decision` | `string` | yes | Human-readable decision summary |
| `created_at` | `string` (ISO 8601) | yes | Record creation timestamp |
| `updated_at` | `string` (ISO 8601) | yes | Record last-updated timestamp |
