//! Operation catalog — structured audit of every compute operation in a
//! compiled model execution plan.
//!
//! Each `OperationRecord` identifies a specific kernel invocation within
//! a decoder layer (or global scope), annotated with its tensor shapes,
//! head layout, and attention regime.  The `OperationCatalog` collects
//! all records into a single serializable artifact suitable for profile
//! analysis, scheduling decisions, and hardware-capability matching.
//!
//! # Gemma 4 12B reference shapes (default for plan-independent queries)
//!
//! | Property | Sliding | Global |
//! |---|---|---|
//! | hidden_size | 3840 | 3840 |
//! | intermediate_size | 15360 | 15360 |
//! | n_kv_heads | 8 | 1 |
//! | head_dim | 256 | 512 |
//! | layers | 48 | 48 |
//! | vocab_size | 256000 | 256000 |

use crate::config::ModelExecutionPlan;
use serde::{Deserialize, Serialize};

// ── Operation kind ─────────────────────────────────────────────────────────

/// Every distinct compute kernel the runtime can dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OperationKind {
    InputLayerNorm,
    QProj,
    KProj,
    VProj,
    QNorm,
    KNorm,
    RoPE,
    Attention,
    OProj,
    PostAttentionLayerNorm,
    GateProj,
    UpProj,
    SiLU,
    GateTimesUp,
    DownProj,
    EmbeddingLookup,
    FinalNorm,
    OutputProjection,
    Softcap,
    Argmax,
}

// ── Record ─────────────────────────────────────────────────────────────────

/// Shape-annotated invocation of a single operation within the model graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationRecord {
    /// Which kernel this record describes.
    pub kind: OperationKind,
    /// Layer index (0-based), or `None` for global operations (embedding,
    /// final norm, output projection, softcap, argmax).
    pub layer_index: Option<u32>,
    /// Attention regime: `"sliding_attention"`, `"full_attention"`, or
    /// `None` for non-attention / global ops.
    pub attention_kind: Option<String>,
    /// Input feature dimension (hidden_size for norms and projections,
    /// head_dim for per-head Q/K norms, intermediate_size for activations).
    pub dim_in: u32,
    /// Output feature dimension.
    pub dim_out: u32,
    /// Number of query heads (projections and attention only).
    pub n_heads: Option<u32>,
    /// Number of key/value heads (projections and attention only).
    pub n_kv_heads: Option<u32>,
    /// Head dimension.
    pub head_dim: Option<u32>,
    /// FFN intermediate size (gate/up/down projections, SiLU, element-wise
    /// multiply).
    pub intermediate_size: Option<u32>,
}

// ── Catalog ────────────────────────────────────────────────────────────────

/// Complete inventory of every compute operation in an execution plan.
///
/// Produced by [`OperationCatalog::generate_from_plan`] during the
/// compilation pipeline.  The catalog is self-describing: top-level fields
/// mirror the model architecture so consumers can reason about the record
/// set without cross-referencing the original `ModelExecutionPlan`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationCatalog {
    /// Hidden / residual stream dimension.
    pub hidden_size: u32,
    /// Vocabulary size (embedding table rows and lm_head columns).
    pub vocab_size: u32,
    /// Number of decoder layers (also equals the number of per-layer
    /// operation groups in `records`).
    pub num_hidden_layers: u32,
    /// FFN intermediate (gate/up/down projection) dimension.
    pub intermediate_size: u32,
    /// Total query heads (sliding and full layers share this).
    pub num_attention_heads: u32,
    /// Key-value heads for sliding-attention layers.
    pub num_key_value_heads: u32,
    /// Head dimension for sliding-attention layers.
    pub head_dim: u32,
    /// Head dimension for full-attention layers (`None` when absent).
    pub global_head_dim: Option<u32>,
    /// Key-value heads for full-attention layers.
    pub num_global_key_value_heads: Option<u32>,
    /// Sliding-window size (causal span for local attention).
    pub sliding_window: u32,
    /// All operation records, in execution order.
    pub records: Vec<OperationRecord>,
}

impl OperationCatalog {
    /// Build a full operation catalog from an execution plan.
    ///
    /// Every decoder layer yields 15 records (layer-norm → projection →
    /// norm → projection via SwiGLU).  Global sections add embedding,
    /// final norm, output projection, optional softcap, and argmax.
    ///
    /// The intermediate size is inferred as `hidden_size × 4` (the
    /// standard SwiGLU expansion ratio, matching Gemma 4's 15360 for
    /// hidden_size = 3840).
    pub fn generate_from_plan(plan: &ModelExecutionPlan) -> Self {
        let num_layers = plan.layers.len() as u32;
        let hidden_size = plan.hidden_size;
        let intermediate_size = hidden_size * 4; // standard SwiGLU expansion
        let first = match plan.layers.first() {
            Some(l) => l,
            None => {
                return OperationCatalog {
                    hidden_size,
                    vocab_size: plan.vocab_size,
                    num_hidden_layers: 0,
                    intermediate_size,
                    num_attention_heads: 0,
                    num_key_value_heads: 0,
                    head_dim: 0,
                    global_head_dim: None,
                    num_global_key_value_heads: None,
                    sliding_window: plan.sliding_window,
                    records: Vec::new(),
                };
            }
        };

        let n_heads = first.n_heads;
        let n_kv_heads = first.n_kv_heads;
        let head_dim = first.head_dim;
        let global_head_dim = first.global_head_dim;
        let n_global_kv_heads = first.n_global_kv_heads;

        let mut records = Vec::with_capacity(
            1                                               // embedding
            + num_layers as usize * 15                      // 15 per layer
            + 3                                             // final_norm + output_projection + argmax
            + if plan.final_logit_softcapping.is_some() { 1 } else { 0 }, // softcap
        );

        // ── Global: embedding_lookup ──────────────────────────────────
        records.push(OperationRecord {
            kind: OperationKind::EmbeddingLookup,
            layer_index: None,
            attention_kind: None,
            dim_in: plan.vocab_size,
            dim_out: hidden_size,
            n_heads: None,
            n_kv_heads: None,
            head_dim: None,
            intermediate_size: None,
        });

        // ── Per-layer records ─────────────────────────────────────────
        for layer in &plan.layers {
            let is_full = layer.attention_kind == "full_attention";
            let attn_kind = Some(layer.attention_kind.clone());
            let li = Some(layer.layer_index);

            let hd = if is_full {
                global_head_dim.unwrap_or(layer.head_dim)
            } else {
                layer.head_dim
            };
            let kvh = if is_full {
                n_global_kv_heads.unwrap_or(layer.n_kv_heads)
            } else {
                layer.n_kv_heads
            };

            let q_out_dim = n_heads * hd;
            let kv_out_dim = kvh * hd;

            // 1. input_layernorm
            records.push(OperationRecord {
                kind: OperationKind::InputLayerNorm,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: hidden_size,
                dim_out: hidden_size,
                n_heads: None,
                n_kv_heads: None,
                head_dim: None,
                intermediate_size: None,
            });

            // 2. q_proj
            records.push(OperationRecord {
                kind: OperationKind::QProj,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: hidden_size,
                dim_out: q_out_dim,
                n_heads: Some(n_heads),
                n_kv_heads: Some(kvh),
                head_dim: Some(hd),
                intermediate_size: None,
            });

            // 3. k_proj
            records.push(OperationRecord {
                kind: OperationKind::KProj,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: hidden_size,
                dim_out: kv_out_dim,
                n_heads: Some(n_heads),
                n_kv_heads: Some(kvh),
                head_dim: Some(hd),
                intermediate_size: None,
            });

            // 4. v_proj
            records.push(OperationRecord {
                kind: OperationKind::VProj,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: hidden_size,
                dim_out: kv_out_dim,
                n_heads: Some(n_heads),
                n_kv_heads: Some(kvh),
                head_dim: Some(hd),
                intermediate_size: None,
            });

            // 5. q_norm
            records.push(OperationRecord {
                kind: OperationKind::QNorm,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: hd,
                dim_out: hd,
                n_heads: Some(n_heads),
                n_kv_heads: None,
                head_dim: Some(hd),
                intermediate_size: None,
            });

            // 6. k_norm
            records.push(OperationRecord {
                kind: OperationKind::KNorm,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: hd,
                dim_out: hd,
                n_heads: Some(n_heads),
                n_kv_heads: Some(kvh),
                head_dim: Some(hd),
                intermediate_size: None,
            });

            // 7. RoPE
            records.push(OperationRecord {
                kind: OperationKind::RoPE,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: hd,
                dim_out: hd,
                n_heads: Some(n_heads),
                n_kv_heads: Some(kvh),
                head_dim: Some(hd),
                intermediate_size: None,
            });

            // 8. attention
            records.push(OperationRecord {
                kind: OperationKind::Attention,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: q_out_dim,
                dim_out: q_out_dim,
                n_heads: Some(n_heads),
                n_kv_heads: Some(kvh),
                head_dim: Some(hd),
                intermediate_size: None,
            });

            // 9. o_proj
            records.push(OperationRecord {
                kind: OperationKind::OProj,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: q_out_dim,
                dim_out: hidden_size,
                n_heads: Some(n_heads),
                n_kv_heads: Some(kvh),
                head_dim: Some(hd),
                intermediate_size: None,
            });

            // 10. post_attention_layernorm
            records.push(OperationRecord {
                kind: OperationKind::PostAttentionLayerNorm,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: hidden_size,
                dim_out: hidden_size,
                n_heads: None,
                n_kv_heads: None,
                head_dim: None,
                intermediate_size: None,
            });

            // 11. gate_proj
            records.push(OperationRecord {
                kind: OperationKind::GateProj,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: hidden_size,
                dim_out: intermediate_size,
                n_heads: None,
                n_kv_heads: None,
                head_dim: None,
                intermediate_size: Some(intermediate_size),
            });

            // 12. up_proj
            records.push(OperationRecord {
                kind: OperationKind::UpProj,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: hidden_size,
                dim_out: intermediate_size,
                n_heads: None,
                n_kv_heads: None,
                head_dim: None,
                intermediate_size: Some(intermediate_size),
            });

            // 13. SiLU activation
            records.push(OperationRecord {
                kind: OperationKind::SiLU,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: intermediate_size,
                dim_out: intermediate_size,
                n_heads: None,
                n_kv_heads: None,
                head_dim: None,
                intermediate_size: Some(intermediate_size),
            });

            // 14. gate * up (element-wise multiply)
            records.push(OperationRecord {
                kind: OperationKind::GateTimesUp,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: intermediate_size,
                dim_out: intermediate_size,
                n_heads: None,
                n_kv_heads: None,
                head_dim: None,
                intermediate_size: Some(intermediate_size),
            });

            // 15. down_proj
            records.push(OperationRecord {
                kind: OperationKind::DownProj,
                layer_index: li,
                attention_kind: attn_kind.clone(),
                dim_in: intermediate_size,
                dim_out: hidden_size,
                n_heads: None,
                n_kv_heads: None,
                head_dim: None,
                intermediate_size: Some(intermediate_size),
            });
        }

        // ── Global: final_norm ────────────────────────────────────────
        records.push(OperationRecord {
            kind: OperationKind::FinalNorm,
            layer_index: None,
            attention_kind: None,
            dim_in: hidden_size,
            dim_out: hidden_size,
            n_heads: None,
            n_kv_heads: None,
            head_dim: None,
            intermediate_size: None,
        });

        // ── Global: output_projection (lm_head) ───────────────────────
        records.push(OperationRecord {
            kind: OperationKind::OutputProjection,
            layer_index: None,
            attention_kind: None,
            dim_in: hidden_size,
            dim_out: plan.vocab_size,
            n_heads: None,
            n_kv_heads: None,
            head_dim: None,
            intermediate_size: None,
        });

        // ── Global: softcap (final_logit_softcapping) ─────────────────
        if plan.final_logit_softcapping.is_some() {
            records.push(OperationRecord {
                kind: OperationKind::Softcap,
                layer_index: None,
                attention_kind: None,
                dim_in: plan.vocab_size,
                dim_out: plan.vocab_size,
                n_heads: None,
                n_kv_heads: None,
                head_dim: None,
                intermediate_size: None,
            });
        }

        // ── Global: argmax ────────────────────────────────────────────
        records.push(OperationRecord {
            kind: OperationKind::Argmax,
            layer_index: None,
            attention_kind: None,
            dim_in: plan.vocab_size,
            dim_out: 1,
            n_heads: None,
            n_kv_heads: None,
            head_dim: None,
            intermediate_size: None,
        });

        OperationCatalog {
            hidden_size,
            vocab_size: plan.vocab_size,
            num_hidden_layers: num_layers,
            intermediate_size,
            num_attention_heads: n_heads,
            num_key_value_heads: n_kv_heads,
            head_dim,
            global_head_dim,
            num_global_key_value_heads: n_global_kv_heads,
            sliding_window: plan.sliding_window,
            records,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        EpiloguePlan, LayerPlan, ModelExecutionPlan, ProloguePlan,
    };

    /// Build a minimal Gemma-4-like plan with 2 layers (one sliding, one
    /// full) so we can verify record shapes without loading 48 layers of
    /// fixture data.
    fn gemma4_plan() -> ModelExecutionPlan {
        ModelExecutionPlan {
            hidden_size: 3840,
            vocab_size: 256000,
            sliding_window: 8192,
            final_logit_softcapping: Some(30.0),
            tie_word_embeddings: false,
            rms_norm_eps: 1e-6,
            prologue: ProloguePlan {
                segment_id: "persistent".into(),
                embedding_tensor_id: 1,
                embedding_name: "model.embed_tokens.weight".into(),
                embedding_shape: vec![256000, 3840],
                embedding_dtype: "U8".into(),
            },
            layers: vec![
                // Layer 0: sliding attention
                LayerPlan {
                    layer_index: 0,
                    attention_kind: "sliding_attention".into(),
                    segment_id: "layer_0".into(),
                    hidden_size: 3840,
                    n_heads: 16,
                    n_kv_heads: 8,
                    head_dim: 256,
                    global_head_dim: None,
                    n_global_kv_heads: None,
                    sliding_window: 8192,
                    rope_theta: 10000.0,
                    partial_rotary_factor: Some(1.0),
                    attention_k_eq_v: false,
                    q_norm_enabled: true,
                    k_norm_enabled: true,
                    q_proj_tensor_id: 10,
                    k_proj_tensor_id: 11,
                    v_proj_tensor_id: 12,
                    o_proj_tensor_id: 13,
                    q_norm_tensor_id: Some(14),
                    k_norm_tensor_id: Some(15),
                    gate_proj_tensor_id: 16,
                    up_proj_tensor_id: 17,
                    down_proj_tensor_id: 18,
                    input_layernorm_tensor_id: 19,
                    post_attention_layernorm_tensor_id: 20,
                    pre_ffw_layernorm_tensor_id: None,
                    post_ffw_layernorm_tensor_id: None,
                    layer_scalar_ids: Vec::new(),
                    quantization_ids: Vec::new(),
                },
                // Layer 1: full attention
                LayerPlan {
                    layer_index: 1,
                    attention_kind: "full_attention".into(),
                    segment_id: "layer_1".into(),
                    hidden_size: 3840,
                    n_heads: 16,
                    n_kv_heads: 1,
                    head_dim: 512,
                    global_head_dim: Some(512),
                    n_global_kv_heads: Some(1),
                    sliding_window: 8192,
                    rope_theta: 1000000.0,
                    partial_rotary_factor: Some(1.0),
                    attention_k_eq_v: true,
                    q_norm_enabled: true,
                    k_norm_enabled: true,
                    q_proj_tensor_id: 30,
                    k_proj_tensor_id: 31,
                    v_proj_tensor_id: 31, // k=v alias
                    o_proj_tensor_id: 33,
                    q_norm_tensor_id: Some(34),
                    k_norm_tensor_id: Some(35),
                    gate_proj_tensor_id: 36,
                    up_proj_tensor_id: 37,
                    down_proj_tensor_id: 38,
                    input_layernorm_tensor_id: 39,
                    post_attention_layernorm_tensor_id: 40,
                    pre_ffw_layernorm_tensor_id: None,
                    post_ffw_layernorm_tensor_id: None,
                    layer_scalar_ids: Vec::new(),
                    quantization_ids: Vec::new(),
                },
            ],
            epilogue: EpiloguePlan {
                segment_id: "persistent".into(),
                final_norm_tensor_id: 50,
                final_norm_name: "model.norm.weight".into(),
                output_projection_tensor_id: Some(51),
                output_projection_name: Some("lm_head.weight".into()),
                final_logit_softcapping: Some(30.0),
                vocab_size: 256000,
            },
        }
    }

    #[test]
    fn catalog_record_count() {
        let plan = gemma4_plan();
        let catalog = OperationCatalog::generate_from_plan(&plan);

        // 1 embedding + 2×15 layer + 1 final_norm + 1 output_projection
        // + 1 softcap + 1 argmax = 35
        assert_eq!(catalog.records.len(), 35);
        assert_eq!(catalog.num_hidden_layers, 2);
    }

    #[test]
    fn catalog_globals() {
        let plan = gemma4_plan();
        let catalog = OperationCatalog::generate_from_plan(&plan);

        // Verify global records (no layer index)
        let globals: Vec<&OperationRecord> =
            catalog.records.iter().filter(|r| r.layer_index.is_none()).collect();
        assert_eq!(globals.len(), 5); // embedding + final_norm + output_projection + softcap + argmax

        assert_eq!(globals[0].kind, OperationKind::EmbeddingLookup);
        assert_eq!(globals[0].dim_in, 256000);
        assert_eq!(globals[0].dim_out, 3840);

        assert_eq!(globals[1].kind, OperationKind::FinalNorm);
        assert_eq!(globals[1].dim_in, 3840);
        assert_eq!(globals[1].dim_out, 3840);

        assert_eq!(globals[2].kind, OperationKind::OutputProjection);
        assert_eq!(globals[2].dim_in, 3840);
        assert_eq!(globals[2].dim_out, 256000);

        assert_eq!(globals[3].kind, OperationKind::Softcap);
        assert_eq!(globals[3].dim_in, 256000);
        assert_eq!(globals[3].dim_out, 256000);

        assert_eq!(globals[4].kind, OperationKind::Argmax);
        assert_eq!(globals[4].dim_in, 256000);
        assert_eq!(globals[4].dim_out, 1);
    }

    #[test]
    fn catalog_sliding_layer_shapes() {
        let plan = gemma4_plan();
        let catalog = OperationCatalog::generate_from_plan(&plan);

        // Layer 0 is sliding attention: n_kv=8, hd=256
        let layer_0: Vec<&OperationRecord> = catalog
            .records
            .iter()
            .filter(|r| r.layer_index == Some(0))
            .collect();
        assert_eq!(layer_0.len(), 15);

        // QProj: dim_in=3840, dim_out=16×256=4096
        let q = layer_0[1];
        assert_eq!(q.kind, OperationKind::QProj);
        assert_eq!(q.dim_in, 3840);
        assert_eq!(q.dim_out, 4096);
        assert_eq!(q.n_heads, Some(16));
        assert_eq!(q.n_kv_heads, Some(8));
        assert_eq!(q.head_dim, Some(256));

        // KProj/VProj: dim_out = 8×256 = 2048
        let k = layer_0[2];
        assert_eq!(k.kind, OperationKind::KProj);
        assert_eq!(k.dim_out, 2048);

        let v = layer_0[3];
        assert_eq!(v.kind, OperationKind::VProj);
        assert_eq!(v.dim_out, 2048);

        // QNorm/KNorm/RoPE: head_dim=256
        let qn = layer_0[4];
        assert_eq!(qn.kind, OperationKind::QNorm);
        assert_eq!(qn.dim_in, 256);

        let kn = layer_0[5];
        assert_eq!(kn.kind, OperationKind::KNorm);
        assert_eq!(kn.dim_in, 256);

        let rope = layer_0[6];
        assert_eq!(rope.kind, OperationKind::RoPE);
        assert_eq!(rope.dim_in, 256);

        // Attention: dim_in/out = 4096
        let attn = layer_0[7];
        assert_eq!(attn.kind, OperationKind::Attention);
        assert_eq!(attn.dim_in, 4096);
        assert_eq!(attn.dim_out, 4096);

        // OProj: 4096 → 3840
        let o = layer_0[8];
        assert_eq!(o.kind, OperationKind::OProj);
        assert_eq!(o.dim_in, 4096);
        assert_eq!(o.dim_out, 3840);

        // FFN projections: hidden→intermediate
        let gate = layer_0[10];
        assert_eq!(gate.kind, OperationKind::GateProj);
        assert_eq!(gate.dim_in, 3840);
        assert_eq!(gate.dim_out, 15360);
        assert_eq!(gate.intermediate_size, Some(15360));

        let up = layer_0[11];
        assert_eq!(up.kind, OperationKind::UpProj);
        assert_eq!(up.dim_in, 3840);
        assert_eq!(up.dim_out, 15360);

        let silu = layer_0[12];
        assert_eq!(silu.kind, OperationKind::SiLU);
        assert_eq!(silu.dim_in, 15360);

        let gxu = layer_0[13];
        assert_eq!(gxu.kind, OperationKind::GateTimesUp);
        assert_eq!(gxu.dim_in, 15360);

        let down = layer_0[14];
        assert_eq!(down.kind, OperationKind::DownProj);
        assert_eq!(down.dim_in, 15360);
        assert_eq!(down.dim_out, 3840);
    }

    #[test]
    fn catalog_full_layer_shapes() {
        let plan = gemma4_plan();
        let catalog = OperationCatalog::generate_from_plan(&plan);

        // Layer 1 is full attention: n_kv=1, hd=512
        let layer_1: Vec<&OperationRecord> = catalog
            .records
            .iter()
            .filter(|r| r.layer_index == Some(1))
            .collect();
        assert_eq!(layer_1.len(), 15);

        // QProj: 3840 → 16×512 = 8192
        let q = layer_1[1];
        assert_eq!(q.kind, OperationKind::QProj);
        assert_eq!(q.dim_in, 3840);
        assert_eq!(q.dim_out, 8192);
        assert_eq!(q.n_heads, Some(16));
        assert_eq!(q.n_kv_heads, Some(1));
        assert_eq!(q.head_dim, Some(512));

        // KProj/VProj: 3840 → 1×512 = 512
        let k = layer_1[2];
        assert_eq!(k.kind, OperationKind::KProj);
        assert_eq!(k.dim_out, 512);

        let v = layer_1[3];
        assert_eq!(v.kind, OperationKind::VProj);
        assert_eq!(v.dim_out, 512);

        // QNorm/KNorm/RoPE: head_dim=512
        assert_eq!(layer_1[4].dim_in, 512); // q_norm
        assert_eq!(layer_1[5].dim_in, 512); // k_norm
        assert_eq!(layer_1[6].dim_in, 512); // rope

        // Attention: dim_in/out = 8192
        let attn = layer_1[7];
        assert_eq!(attn.kind, OperationKind::Attention);
        assert_eq!(attn.dim_in, 8192);
        assert_eq!(attn.dim_out, 8192);

        // OProj: 8192 → 3840
        let o = layer_1[8];
        assert_eq!(o.kind, OperationKind::OProj);
        assert_eq!(o.dim_in, 8192);
        assert_eq!(o.dim_out, 3840);
    }

    #[test]
    fn catalog_serde_roundtrip() {
        let plan = gemma4_plan();
        let catalog = OperationCatalog::generate_from_plan(&plan);

        let json = serde_json::to_string(&catalog).unwrap();
        let restored: OperationCatalog = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.hidden_size, 3840);
        assert_eq!(restored.records.len(), catalog.records.len());
        for (a, b) in catalog.records.iter().zip(restored.records.iter()) {
            assert_eq!(a.kind, b.kind);
            assert_eq!(a.layer_index, b.layer_index);
            assert_eq!(a.dim_in, b.dim_in);
            assert_eq!(a.dim_out, b.dim_out);
        }
    }

    #[test]
    fn catalog_empty_plan() {
        let plan = ModelExecutionPlan {
            hidden_size: 3840,
            vocab_size: 256000,
            sliding_window: 8192,
            final_logit_softcapping: None,
            tie_word_embeddings: false,
            rms_norm_eps: 1e-6,
            prologue: ProloguePlan::default(),
            layers: vec![],
            epilogue: EpiloguePlan::default(),
        };
        let catalog = OperationCatalog::generate_from_plan(&plan);
        // Only globals: embedding + final_norm + output_projection + argmax = 4
        // (no softcap since final_logit_softcapping is None)
        assert_eq!(catalog.records.len(), 4);
        assert_eq!(catalog.num_hidden_layers, 0);
    }

    #[test]
    fn catalog_no_softcap() {
        let mut plan = gemma4_plan();
        plan.final_logit_softcapping = None;
        plan.epilogue.final_logit_softcapping = None;
        let catalog = OperationCatalog::generate_from_plan(&plan);

        // 1 embedding + 30 layer + 1 final_norm + 1 output_projection + 1 argmax = 34
        assert_eq!(catalog.records.len(), 34);
        assert!(catalog.records.iter().all(|r| r.kind != OperationKind::Softcap));
    }
}
