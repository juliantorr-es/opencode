# Pipeline Stages — Inference Research Evidence Plane v1

**Version:** 1.0.0  
**Schema:** `research/schemas/pipeline-taxonomy.v1.json`  
**Status:** Phase 0 — Frozen  

This document defines the complete set of pipeline stage IDs, execution substrate IDs, and stage-substrate event mapping rules for the Tribunus Inference Research Evidence Plane. All definitions are stable: existing meanings never change. New stages and substrates may be added in future versions.

---

## Pipeline Stage IDs

Forty-two stages covering the full lifecycle of a transformer-based inference request, from worker launch through worker shutdown. Stages 1–7 are initialization (one-shot), stages 8–38 are per-token (repeated for each decode step), and stages 39–42 are teardown (one-shot).

### Initialization (one-shot per inference invocation)

| ID | Name | Description |
|----|------|-------------|
| 1 | `worker_launch` | Launch the compute worker process, initializing its runtime and IPC channels. First stage in every pipeline invocation. |
| 2 | `model_verification` | Verify that the requested model is loaded, valid, and matches the expected checksum or manifest. Fail-fast gate before tensor work begins. |
| 3 | `segment_mapping` | Map the logical model graph into memory segments or shards. Determines which tensors reside on which devices or memory pools. |
| 4 | `tensor_binding` | Bind logical tensors to concrete device memory buffers. Resolves segment mappings into physical allocations. |
| 5 | `persistent_materialization` | Materialize or load persistent model weights (safetensors, checkpoint) into the bound tensor buffers. May be skipped if weights already resident. |
| 6 | `model_admission` | Admit the model into the inference graph: final integrity check, warmup, and graph compilation or JIT if applicable. Model is ready for inference after this stage. |
| 7 | `rope_construction` | Precompute Rotary Position Embedding (RoPE) frequency tables for the current context length. Cached and reused across decode steps. |

### Per-Token (repeated each decode step)

| ID | Name | Description |
|----|------|-------------|
| 8 | `session_creation` | Create an inference session: per-request context, KV cache reservation, sequence tracking. Each prompt or continuation opens a session. |
| 9 | `embedding_gather` | Gather input token embeddings from the embedding table. Converts token IDs to dense vectors. |
| 10 | `embedding_dequantization` | Dequantize embedding weights if stored in quantized format (e.g. NF4, GPTQ). Outputs full-precision embeddings. |
| 11 | `embedding_scaling` | Apply embedding scaling factor (e.g. sqrt(d_model)) to normalize raw embeddings before attention layers. |
| 12 | `input_normalization` | Apply input (pre-attention) layer normalization (LayerNorm, RMSNorm, etc.) to the embedding vector. |
| 13 | `q_projection` | Project normalized input through the query weight matrix (W_q). Produces the query tensor for attention. |
| 14 | `k_projection` | Project normalized input through the key weight matrix (W_k). Produces the key tensor for attention. |
| 15 | `v_projection` | Project normalized input through the value weight matrix (W_v). Produces the value tensor for attention. |
| 16 | `q_normalization` | Apply QK normalization (if separate from input norm) to the query tensor. Optional; depends on architecture (e.g. LLaMA 3+). |
| 17 | `k_normalization` | Apply QK normalization (if separate from input norm) to the key tensor. Optional; depends on architecture. |
| 18 | `rope_application` | Apply Rotary Position Embedding to the query and key tensors. Uses the precomputed RoPE tables from `rope_construction`. |
| 19 | `kv_candidate_append` | Append the current key and value tensors as candidates in the KV cache ring buffer. Pre-commit phase before cache eviction policy runs. |
| 20 | `kv_commit` | Commit key-value pairs to the persistent KV cache. Eviction policy (e.g. evict-first, rolling window) is applied here. |
| 21 | `attention_mask_construction` | Build the causal attention mask, optionally incorporating ALiBi bias, sliding window, or sparse pattern masks. |
| 22 | `attention_score` | Compute raw attention scores: Q @ K^T scaled by 1/sqrt(d_k). Produces the pre-softmax score matrix. |
| 23 | `attention_softmax` | Apply softmax (or alternative normalization like ReLU/KDE) to the attention scores, masking out invalid positions via the attention mask. |
| 24 | `attention_value` | Compute the weighted sum of values: softmax(QK^T) @ V. Produces the per-head attention output. |
| 25 | `output_projection` | Project concatenated attention heads through the output weight matrix (W_o). Multi-head attention output. |
| 26 | `residual_connection` | Add the multi-head attention output to the residual stream (input + attention_output). First residual in each transformer block. |
| 27 | `post_attention_normalization` | Apply post-attention (pre-FFN) layer normalization to the residual stream. |
| 28 | `mlp_gate_projection` | Compute the gate projection (W_gate) for the gated MLP (SwiGLU, GeGLU, etc.). |
| 29 | `mlp_up_projection` | Compute the up projection (W_up) for the gated MLP: the expansion path from d_model to d_ff. |
| 30 | `activation` | Apply pointwise activation function (SiLU, GELU, ReLU) to the gate projection. |
| 31 | `elementwise_gate` | Elementwise multiply (gate) the activated gate projection with the up projection: activation(W_gate(x)) * W_up(x). |
| 32 | `mlp_down_projection` | Compute the down projection (W_down) of the gated MLP: contraction from d_ff back to d_model. |
| 33 | `final_normalization` | Apply the final layer normalization to the transformer stack output before vocabulary projection. |
| 34 | `vocabulary_projection` | Project the normalized output through the language model head (lm_head) to produce logits over the vocabulary. |
| 35 | `logit_softcap` | Apply logit soft-capping (if configured) to clamp extreme logit values. Optional; depends on model architecture. |
| 36 | `sampling` | Sample the next token from the logit distribution. Applies temperature, top-k, top-p, repetition penalty, and other sampling strategies. |
| 37 | `scalar_token_transfer` | Transfer the sampled token (a scalar token ID) from the compute worker back to the control plane. Boundary crossing between compute and orchestration. |
| 38 | `token_streaming` | Stream the decoded token(s) to the client or consumer via the response channel (SSE, WebSocket, streaming HTTP). |

### Teardown (one-shot per inference invocation)

| ID | Name | Description |
|----|------|-------------|
| 39 | `request_finalization` | Finalize the inference request: send EOS/stop signal, collect telemetry, aggregate per-request metrics. Request is complete after this stage. |
| 40 | `session_cleanup` | Release per-session resources: KV cache allocations, intermediate tensors, session metadata, and any device-side buffers. |
| 41 | `model_unload` | Unload the model from device memory: release weight tensors, compiled graphs, and device-side model state. Last stage before worker teardown. |
| 42 | `worker_shutdown` | Shut down the compute worker process: close IPC channels, flush logs, release host resources, and exit. Terminal stage. |

---

## Execution Substrate IDs

Eleven execution substrates spanning CPU fallback through GPU, ANE, and the control plane.

| ID | Name | Description |
|----|------|-------------|
| 0 | `cpu_scalar` | Scalar CPU execution — single-threaded, no acceleration. Universal fallback; every stage MUST have a cpu_scalar path. |
| 1 | `cpu_accelerate` | CPU execution via Apple Accelerate framework (BLAS/LAPACK vectorized). Multi-threaded, uses AMX coprocessor when available. |
| 2 | `mlx_generic_cpu` | MLX framework execution on CPU via the mlx-rs bindings. Uses MLX's default CPU backend with lazy evaluation and JIT compilation. |
| 3 | `mlx_generic_gpu` | MLX framework execution on Apple GPU via Metal Performance Shaders (MPS) backend. MLX's primary GPU path. |
| 4 | `mlx_custom_extension` | MLX execution via custom C++ extensions written against the mlx-rs or mlx-sys APIs. Used for optimized kernels not in upstream MLX. |
| 5 | `tribunus_metal` | Tribunus-native Metal Performance Shaders and custom Metal shader kernels, bypassing MLX for direct GPU compute. Includes megakernel paths. |
| 6 | `coreml_cpu` | Apple Core ML execution on CPU via the Core ML framework's CPU backend. |
| 7 | `coreml_gpu` | Apple Core ML execution on GPU via the Core ML framework's Metal backend. |
| 8 | `coreml_ane` | Apple Core ML execution on the Apple Neural Engine (ANE). Deploys to the dedicated ANE hardware. |
| 9 | `orion_ane_research` | Research substrate for Orion ANE (experimental Apple Neural Engine compiler/runtime). Not for production use. |
| 10 | `control_plane` | Control plane orchestrator execution. Used for stages that run outside the compute worker (e.g. request finalization, session cleanup, worker lifecycle). |

---

## Stage-Substrate Event Mapping Rules

### Event Schema

A stage-substrate mapping event captures which substrate executed which stage, with optional contextual metadata.

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `stage_id` | integer (1–65535) | Numeric identifier of the pipeline stage. Values 1–42 defined in v1. |
| `substrate_id` | integer (0–65535) | Numeric identifier of the execution substrate. Values 0–10 defined in v1. |
| `backend` | string | Canonical backend name (e.g. `mlx`, `tribunus-metal`, `coreml`, `accelerate`, `cpu`). |

**Optional fields:**

| Field | Type | Description |
|-------|------|-------------|
| `layer_index` | integer (0+) | Index of the transformer layer this event applies to. 0-based. Omitted for non-layer-specific stages. |
| `attention_kind` | enum | Kind of attention mechanism: `mha` (multi-head), `mqa` (multi-query), `gqa` (grouped-query), `mla` (multi-head latent). |
| `graph_region_id` | string | Identifier for the model graph region or subgraph. Enables hierarchical tracing. |
| `kernel_id` | string | Specific kernel or shader function name (e.g. `metal::attention_kernel_v1`, `mlx::scaled_dot_product_attention`). |

### Fallback Recording

When a stage fails to execute on its primary substrate and falls back to an alternative:

1. **Both events are recorded.** The failed attempt on the primary substrate is recorded as a distinct event, and the successful execution on the fallback substrate is recorded as another distinct event.
2. **Fallback events carry extra fields:** `primary_substrate_id` (the originally targeted substrate) and `fallback_reason` (a string describing why the fallback occurred, e.g. `kernel_not_found`, `device_memory_pressure`, `substrate_not_available`, `timeout`).
3. **No implicit fallbacks.** A fallback is never implied or merged; it is always explicit in the event stream.

### Schema Versioning

- **Backward compatibility:** Existing stage and substrate IDs MUST never be reassigned, repurposed, or removed. New IDs may be added with strictly increasing values.
- **Stage immutability:** Once assigned, a stage ID and its name are permanent. The semantic meaning of a stage MUST NOT change. Clarifying descriptions may be amended.
- **Substrate immutability:** Once assigned, a substrate ID and its name are permanent. A substrate's general capability domain MUST NOT change, though implementation details may evolve.
- **Deprecation:** If a stage or substrate becomes obsolete, it MUST NOT be reused. The definition is marked deprecated (removed from the recommended set of IDs) but the ID and definition remain in the schema for historical traceability.

---

## Pipeline Flow Diagram

```
WORKER LIFECYCLE (one-shot):
  worker_launch (1)
  → model_verification (2)
  → segment_mapping (3)
  → tensor_binding (4)
  → persistent_materialization (5)
  → model_admission (6)
  → rope_construction (7)

PER-TOKEN LOOP (repeated each decode step):
  session_creation (8)
  → embedding_gather → embedding_dequantization → embedding_scaling (9→10→11)
  → input_normalization (12)
  → q_projection, k_projection, v_projection (13→14→15)  [parallel projections]
  → q_normalization, k_normalization (16→17)              [optional, per architecture]
  → rope_application (18)
  → kv_candidate_append → kv_commit (19→20)
  → attention_mask_construction (21)
  → attention_score → attention_softmax → attention_value (22→23→24)
  → output_projection → residual_connection (25→26)
  → post_attention_normalization (27)
  → mlp_gate_projection → mlp_up_projection (28→29)       [parallel projections]
  → activation (30)
  → elementwise_gate (31)
  → mlp_down_projection (32)
  → final_normalization (33)
  → vocabulary_projection → logit_softcap (34→35)         [logit_softcap: optional]
  → sampling (36)
  → scalar_token_transfer (37)
  → token_streaming (38)
  [loop back to session_creation (8) for next token, or proceed to teardown]

TEARDOWN (one-shot):
  request_finalization (39)
  → session_cleanup (40)
  → model_unload (41)
  → worker_shutdown (42)
```
