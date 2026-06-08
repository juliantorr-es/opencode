//! Config-driven architecture for Tribunus Compute Kernel.
//!
//! Layer 1: Raw model manifest — captures config.json hash and structure.
//! Layer 2: Normalized architecture — strict Rust types from JSON.
//! Layer 3: Compiled execution specification — per-layer dimensions, policies, tensor shapes.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

// ── Layer 1: Raw Manifest ──────────────────────────────────────────────────

/// Raw model manifest read from config.json.
#[derive(Serialize)]
pub struct ModelManifest {
    pub config_path: String,
    pub config_hash: String,
    pub model_type: String,
    pub has_text_config: bool,
    pub has_quantization_metadata: bool,
    pub quantization_bits: Option<u32>,
    pub quantization_group_size: Option<u32>,
    pub quantization_mode: Option<String>,
    pub safetensors_shards: Vec<ShardManifest>,
}

#[derive(Serialize)]
pub struct ShardManifest {
    pub path: String,
    pub sha256: String,
    pub tensor_count: usize,
}

// ── Layer 2: Normalized Architecture ───────────────────────────────────────

/// Fully resolved text model architecture from config.json.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextArchitecture {
    pub hidden_size: u32,
    pub intermediate_size: u32,
    pub num_attention_heads: u32,
    pub num_key_value_heads: u32,
    pub head_dim: u32,
    pub global_head_dim: Option<u32>,
    pub num_global_key_value_heads: Option<u32>,
    pub num_hidden_layers: u32,
    pub vocab_size: u32,
    pub sliding_window: u32,
    pub max_position_embeddings: u32,
    pub rms_norm_eps: f64,
    pub tie_word_embeddings: bool,
    pub attention_k_eq_v: bool,
    pub final_logit_softcapping: Option<f64>,
    pub hidden_size_per_layer_input: u32,
    pub layer_types: Vec<AttentionKind>,
    pub rope_local: RopeSpec,
    pub rope_global: Option<RopeSpec>,
    pub model_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttentionKind {
    SlidingAttention,
    FullAttention,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RopeSpec {
    pub theta: f64,
    pub rope_type: String,
    pub partial_rotary_factor: Option<f64>,
}

/// Quantization metadata from the converted model.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QuantizationMeta {
    pub bits: u32,
    pub group_size: u32,
    pub mode: QuantizationMode,
    /// Per-layer overrides (if any layer has non-default group size or bits).
    pub overrides: HashMap<String, QuantizationMeta>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum QuantizationMode {
    None,
    Affine,
    Symmetric,
}

// ── Layer 3: Compiled Execution Specification ──────────────────────────────

/// Full execution plan: one spec per layer, plus global tensors.
#[derive(Debug, Serialize)]
pub struct ExecutionSpec {
    pub architecture: TextArchitecture,
    pub namespace: NamespaceBinding,
    pub global_tensors: Vec<TensorBinding>,
    pub layers: Vec<LayerSpec>,
    pub quantization: Option<QuantizationMeta>,
}

/// Selected namespace root for text model tensors.
#[derive(Debug, Serialize)]
pub struct NamespaceBinding {
    pub root: String,
    /// How the root was discovered.
    pub discovery: String,
    /// Where lm_head.weight lives (may alias embed_tokens if tied).
    pub lm_head_key: String,
    pub lm_head_aliased: bool,
}

/// A layer's complete specification.
#[derive(Debug, Serialize)]
pub struct LayerSpec {
    pub index: u32,
    pub attention_kind: AttentionKind,
    pub q_out: u32,
    pub kv_out: u32,
    pub n_heads: u32,
    pub n_kv_heads: u32,
    pub head_dim: u32,
    pub global_kv_out: Option<u32>,
    pub n_global_kv_heads: Option<u32>,
    pub global_head_dim: Option<u32>,
    pub rope_theta: f64,
    pub rope_type: String,
    pub partial_rotary_factor: Option<f64>,
    pub sliding_window: Option<u32>,
    pub tensors: Vec<TensorBinding>,
}

/// A single tensor's expected identity in the safetensors file.
#[derive(Debug, Serialize)]
pub struct TensorBinding {
    pub name: String,
    pub role: TensorRole,
    pub logical_shape: Vec<u32>,
    /// If quantized: the packed weight shape (i8→u32 packing).
    pub packed_shape: Option<PackedLinearShapes>,
}

#[derive(Debug, Serialize)]
pub struct PackedLinearShapes {
    pub weight: Vec<u32>,
    pub scales: Vec<u32>,
    pub biases: Vec<u32>,
    pub bits: u32,
    pub group_size: u32,
    pub groups: u32,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub enum TensorRole {
    Embedding,
    FinalNorm,
    LmHead,
    AttentionNorm,
    FfnNorm,
    QProj,
    KProj,
    VProj,
    OProj,
    GlobalKProj,
    GlobalVProj,
    GateProj,
    UpProj,
    DownProj,
    QNorm,
    KNorm,
}

// ── Compiler

/// Compile a TextArchitecture into an ExecutionSpec.
/// Complete model execution plan emitted by the compiler.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelExecutionPlan {
    pub prologue: ProloguePlan,
    pub layers: Vec<LayerPlan>,
    pub epilogue: EpiloguePlan,
    pub hidden_size: u32,
    pub vocab_size: u32,
    pub sliding_window: u32,
    pub final_logit_softcapping: Option<f64>,
    pub tie_word_embeddings: bool,
    pub rms_norm_eps: f64,
}

/// Segment ID containing the embedding table.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProloguePlan {
    /// Segment ID containing the embedding table.
    pub segment_id: String,
    /// Tensor entry ID for the embedding weights.
    pub embedding_tensor_id: u32,
    /// Name used for ARRAY_REGISTRY lookup (e.g. "model.embed_tokens.weight").
    pub embedding_name: String,
    /// Expected embedding shape [vocab_size, hidden_size].
    pub embedding_shape: Vec<u32>,
    pub embedding_dtype: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerPlan {
    pub layer_index: u32,
    pub attention_kind: String, // "sliding_attention" or "full_attention"
    pub segment_id: String,
    pub hidden_size: u32,
    pub n_heads: u32,
    pub n_kv_heads: u32,
    pub head_dim: u32,
    /// For global layers only.
    pub global_head_dim: Option<u32>,
    pub n_global_kv_heads: Option<u32>,
    pub sliding_window: u32,
    pub rope_theta: f32,
    pub partial_rotary_factor: Option<f32>,
    pub attention_k_eq_v: bool,
    pub q_norm_enabled: bool,
    pub k_norm_enabled: bool,
    /// Tensor IDs for this layer's weights in the tensor_table.
    pub q_proj_tensor_id: u32,
    pub k_proj_tensor_id: u32,
    pub v_proj_tensor_id: u32,
    pub o_proj_tensor_id: u32,
    pub q_norm_tensor_id: Option<u32>,
    pub k_norm_tensor_id: Option<u32>,
    pub gate_proj_tensor_id: u32,
    pub up_proj_tensor_id: u32,
    pub down_proj_tensor_id: u32,
    pub input_layernorm_tensor_id: u32,
    pub post_attention_layernorm_tensor_id: u32,
    pub pre_ffw_layernorm_tensor_id: Option<u32>,
    pub post_ffw_layernorm_tensor_id: Option<u32>,
    /// Layer scalars and other optional tensors.
    pub layer_scalar_ids: Vec<u32>,
    /// Quantization descriptor IDs for packed weight groups.
    pub quantization_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EpiloguePlan {
    pub segment_id: String,
    pub final_norm_tensor_id: u32,
    pub final_norm_name: String,
    pub output_projection_tensor_id: Option<u32>,
    pub output_projection_name: Option<String>,
    pub final_logit_softcapping: Option<f64>,
    pub vocab_size: u32,
}

impl ModelExecutionPlan {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if self.layers.is_empty() {
            errors.push("execution plan has zero layers".into());
        }
        for (i, plan) in self.layers.iter().enumerate() {
            if plan.layer_index != i as u32 {
                errors.push(format!("layer {} has index {}", i, plan.layer_index));
            }
            if plan.hidden_size != self.hidden_size {
                errors.push(format!("layer {} hidden_size {} != model {}", i, plan.hidden_size, self.hidden_size));
            }
            if plan.q_proj_tensor_id == 0 {
                errors.push(format!("layer {} has zero q_proj_tensor_id", i));
            }
            if plan.k_proj_tensor_id == 0 {
                errors.push(format!("layer {} has zero k_proj_tensor_id", i));
            }
            if plan.o_proj_tensor_id == 0 {
                errors.push(format!("layer {} has zero o_proj_tensor_id", i));
            }
            if plan.gate_proj_tensor_id == 0 {
                errors.push(format!("layer {} has zero gate_proj_tensor_id", i));
            }
            if plan.up_proj_tensor_id == 0 {
                errors.push(format!("layer {} has zero up_proj_tensor_id", i));
            }
            if plan.down_proj_tensor_id == 0 {
                errors.push(format!("layer {} has zero down_proj_tensor_id", i));
            }
            if plan.input_layernorm_tensor_id == 0 {
                errors.push(format!("layer {} has zero input_layernorm_tensor_id", i));
            }
            if plan.post_attention_layernorm_tensor_id == 0 {
                errors.push(format!("layer {} has zero post_attention_layernorm_tensor_id", i));
            }
            match plan.attention_kind.as_str() {
                "sliding_attention" => {
                    if plan.v_proj_tensor_id == 0 {
                        errors.push(format!("sliding layer {} has zero v_proj_tensor_id", i));
                    }
                }
                "full_attention" => {
                    if plan.global_head_dim.is_none() {
                        errors.push(format!("full-attention layer {} missing global_head_dim", i));
                    }
                }
                other => {
                    errors.push(format!("layer {} has unknown attention_kind: {}", i, other));
                }
            }
            let expected_seg = format!("layer_{}", i);
            if plan.segment_id != expected_seg {
                errors.push(format!("layer {} segment_id '{}' != expected '{}'", i, plan.segment_id, expected_seg));
            }
        }
        if self.prologue.embedding_tensor_id == 0 {
            errors.push("prologue has zero embedding_tensor_id".into());
        }
        if self.epilogue.final_norm_tensor_id == 0 {
            errors.push("epilogue has zero final_norm_tensor_id".into());
        }
        if self.epilogue.vocab_size == 0 {
            errors.push("epilogue has zero vocab_size".into());
        }
        if errors.is_empty() { Ok(()) } else { Err(errors) }
    }
}

/// Build a ModelExecutionPlan from the TextArchitecture, namespace, and emitted tensor IDs.
/// Called during ComputeImage compilation after all tensors have been assigned IDs.
pub fn build_execution_plan(
    arch: &TextArchitecture,
    namespace: &NamespaceBinding,
    emitted_ids: &std::collections::HashMap<String, u32>,
) -> ModelExecutionPlan {
    let root = &namespace.root;
    let mut layers = Vec::with_capacity(arch.layer_types.len());

    for (i, kind) in arch.layer_types.iter().enumerate() {
        let layer = i as u32;
        let base = format!("{}.layers.{}", root, layer);
        let is_full = *kind == AttentionKind::FullAttention;

        let get = |suffix: &str| -> u32 {
            let name = format!("{}.{}", base, suffix);
            emitted_ids.get(&name).copied().unwrap_or(0)
        };
        let get_opt = |suffix: &str| -> Option<u32> {
            let name = format!("{}.{}", base, suffix);
            emitted_ids.get(&name).copied()
        };

        let rope = if is_full {
            arch.rope_global.as_ref().unwrap_or(&arch.rope_local)
        } else {
            &arch.rope_local
        };

        let hdim = if is_full {
            arch.global_head_dim.unwrap_or(arch.head_dim)
        } else {
            arch.head_dim
        };
        let n_kv = if is_full {
            arch.num_global_key_value_heads.unwrap_or(arch.num_key_value_heads)
        } else {
            arch.num_key_value_heads
        };

        layers.push(LayerPlan {
            layer_index: layer,
            attention_kind: if is_full { "full_attention".into() } else { "sliding_attention".into() },
            segment_id: format!("layer_{}", layer),
            hidden_size: arch.hidden_size,
            n_heads: arch.num_attention_heads,
            n_kv_heads: n_kv,
            head_dim: hdim,
            global_head_dim: if is_full { arch.global_head_dim } else { None },
            n_global_kv_heads: if is_full { arch.num_global_key_value_heads } else { None },
            sliding_window: arch.sliding_window,
            rope_theta: rope.theta as f32,
            partial_rotary_factor: rope.partial_rotary_factor.map(|f| f as f32),
            attention_k_eq_v: arch.attention_k_eq_v && is_full,
            q_norm_enabled: true,
            k_norm_enabled: true,
            q_proj_tensor_id: get("self_attn.q_proj.weight"),
            k_proj_tensor_id: get("self_attn.k_proj.weight"),
            v_proj_tensor_id: if is_full {
                get("self_attn.k_proj.weight") // alias: K-equals-V
            } else {
                get("self_attn.v_proj.weight")
            },
            o_proj_tensor_id: get("self_attn.o_proj.weight"),
            q_norm_tensor_id: get_opt("self_attn.q_norm.weight"),
            k_norm_tensor_id: get_opt("self_attn.k_norm.weight"),
            gate_proj_tensor_id: get("mlp.gate_proj.weight"),
            up_proj_tensor_id: get("mlp.up_proj.weight"),
            down_proj_tensor_id: get("mlp.down_proj.weight"),
            input_layernorm_tensor_id: get("input_layernorm.weight"),
            post_attention_layernorm_tensor_id: get("post_attention_layernorm.weight"),
            pre_ffw_layernorm_tensor_id: None,
            post_ffw_layernorm_tensor_id: None,
            layer_scalar_ids: Vec::new(),
            quantization_ids: Vec::new(),
        });
    }

    let embed_name = format!("{}.embed_tokens.weight", root);
    let fn_name = format!("{}.norm.weight", root);
    let lm_head_name = namespace.lm_head_key.clone();

    ModelExecutionPlan {
        prologue: ProloguePlan {
            segment_id: "persistent".into(),
            embedding_tensor_id: emitted_ids.get(&embed_name).copied().unwrap_or(0),
            embedding_name: embed_name,
            embedding_shape: vec![arch.vocab_size, arch.hidden_size],
            embedding_dtype: "U8".into(),
        },
        layers,
        epilogue: EpiloguePlan {
            segment_id: "persistent".into(),
            final_norm_tensor_id: emitted_ids.get(&fn_name).copied().unwrap_or(0),
            final_norm_name: fn_name,
            output_projection_tensor_id: emitted_ids.get(&lm_head_name).copied(),
            output_projection_name: Some(lm_head_name),
            final_logit_softcapping: arch.final_logit_softcapping,
            vocab_size: arch.vocab_size,
        },
        hidden_size: arch.hidden_size,
        vocab_size: arch.vocab_size,
        sliding_window: arch.sliding_window,
        final_logit_softcapping: arch.final_logit_softcapping,
        tie_word_embeddings: arch.tie_word_embeddings,
        rms_norm_eps: arch.rms_norm_eps,
    }
}

pub fn compile(
    arch: &TextArchitecture,
    namespace: &NamespaceBinding,
    q: Option<&QuantizationMeta>,
) -> ExecutionSpec {
    let mut spec = ExecutionSpec {
        architecture: arch.clone(),
        namespace: NamespaceBinding {
            root: namespace.root.clone(),
            discovery: namespace.discovery.clone(),
            lm_head_key: namespace.lm_head_key.clone(),
            lm_head_aliased: namespace.lm_head_aliased,
        },
        global_tensors: Vec::new(),
        layers: Vec::new(),
        quantization: q.cloned(),
    };

    let root = &namespace.root;
    let bits = q.map(|m| m.bits).unwrap_or(16);
    let gs = q.map(|m| m.group_size).unwrap_or(64);

    // Embedding (quantized in 8-bit models)
    spec.global_tensors.push(TensorBinding {
        name: format!("{}.embed_tokens.weight", root),
        role: TensorRole::Embedding,
        logical_shape: vec![arch.vocab_size, arch.hidden_size],
        packed_shape: if q.is_some() {
            let gs = q.as_ref().map(|m| m.group_size).unwrap_or(64);
            let bits = q.as_ref().map(|m| m.bits).unwrap_or(16);
            let pack = 4 / (bits / 8);
            let packed_in = arch.hidden_size / pack;
            let n_groups = arch.hidden_size / gs;
            Some(PackedLinearShapes {
                weight: vec![arch.vocab_size, packed_in],
                scales: vec![arch.vocab_size, n_groups],
                biases: vec![arch.vocab_size, n_groups],
                bits,
                group_size: gs,
                groups: n_groups,
            })
        } else {
            None
        },
    });

    // Final norm
    spec.global_tensors.push(TensorBinding {
        name: format!("{}.norm.weight", root),
        role: TensorRole::FinalNorm,
        logical_shape: vec![arch.hidden_size],
        packed_shape: None,
    });

    // LM head
    if !arch.tie_word_embeddings {
        spec.global_tensors.push(TensorBinding {
            name: format!("{}.lm_head.weight", root),
            role: TensorRole::LmHead,
            logical_shape: vec![arch.vocab_size, arch.hidden_size],
            packed_shape: None,
        });
    }

    // Per-layer compilation
    for (i, kind) in arch.layer_types.iter().enumerate() {
        let layer = i as u32;
        let is_full = *kind == AttentionKind::FullAttention;

        let rope = if is_full {
            arch.rope_global.as_ref().unwrap_or(&arch.rope_local)
        } else {
            &arch.rope_local
        };

        let mut tensors = Vec::new();

        // Attention norms
        tensors.push(norm_binding(
            root,
            layer,
            "input_layernorm",
            TensorRole::AttentionNorm,
            arch.hidden_size,
        ));
        tensors.push(norm_binding(
            root,
            layer,
            "post_attention_layernorm",
            TensorRole::FfnNorm,
            arch.hidden_size,
        ));

        // QK norms
        let norm_dim = if is_full {
            arch.global_head_dim.unwrap_or(arch.head_dim)
        } else {
            arch.head_dim
        };
        tensors.push(TensorBinding {
            name: format!("{}.layers.{}.self_attn.q_norm.weight", root, layer),
            role: TensorRole::QNorm,
            logical_shape: vec![norm_dim],
            packed_shape: None,
        });
        tensors.push(TensorBinding {
            name: format!("{}.layers.{}.self_attn.k_norm.weight", root, layer),
            role: TensorRole::KNorm,
            logical_shape: vec![norm_dim],
            packed_shape: None,
        });

        // QKV projections
        // Full-attention: k_proj uses global dims (1×512), no separate v_proj
        let actual_kv_out = if is_full {
            arch.num_global_key_value_heads.unwrap_or(1)
                * arch.global_head_dim.unwrap_or(arch.head_dim)
        } else {
            arch.num_key_value_heads * arch.head_dim
        };
        tensors.push(quantized_linear(
            root,
            layer,
            "self_attn.q_proj",
            TensorRole::QProj,
            if is_full {
                arch.num_attention_heads * arch.global_head_dim.unwrap_or(arch.head_dim)
            } else {
                arch.num_attention_heads * arch.head_dim
            },
            arch.hidden_size,
            gs,
            bits,
        ));
        tensors.push(quantized_linear(
            root,
            layer,
            "self_attn.k_proj",
            TensorRole::KProj,
            actual_kv_out,
            arch.hidden_size,
            gs,
            bits,
        ));
        if !is_full {
            tensors.push(quantized_linear(
                root,
                layer,
                "self_attn.v_proj",
                TensorRole::VProj,
                arch.num_key_value_heads * arch.head_dim,
                arch.hidden_size,
                gs,
                bits,
            ));
        }
        tensors.push(quantized_linear(
            root,
            layer,
            "self_attn.o_proj",
            TensorRole::OProj,
            arch.hidden_size,
            if is_full {
                arch.num_attention_heads * arch.global_head_dim.unwrap_or(arch.head_dim)
            } else {
                arch.num_attention_heads * arch.head_dim
            },
            gs,
            bits,
        ));

        // MLP
        tensors.push(quantized_linear(
            root,
            layer,
            "mlp.gate_proj",
            TensorRole::GateProj,
            arch.intermediate_size,
            arch.hidden_size,
            gs,
            bits,
        ));
        tensors.push(quantized_linear(
            root,
            layer,
            "mlp.up_proj",
            TensorRole::UpProj,
            arch.intermediate_size,
            arch.hidden_size,
            gs,
            bits,
        ));
        tensors.push(quantized_linear(
            root,
            layer,
            "mlp.down_proj",
            TensorRole::DownProj,
            arch.hidden_size,
            arch.intermediate_size,
            gs,
            bits,
        ));

        let sliding_window = if is_full {
            None
        } else {
            Some(arch.sliding_window)
        };

        spec.layers.push(LayerSpec {
            index: layer,
            attention_kind: kind.clone(),
            q_out: if is_full {
                arch.num_attention_heads * arch.global_head_dim.unwrap_or(arch.head_dim)
            } else {
                arch.num_attention_heads * arch.head_dim
            },
            kv_out: if is_full {
                arch.num_global_key_value_heads.unwrap_or(1)
                    * arch.global_head_dim.unwrap_or(arch.head_dim)
            } else {
                arch.num_key_value_heads * arch.head_dim
            },
            n_heads: arch.num_attention_heads,
            n_kv_heads: arch.num_key_value_heads,
            head_dim: if is_full {
                arch.global_head_dim.unwrap_or(arch.head_dim)
            } else {
                arch.head_dim
            },
            global_kv_out: if is_full {
                Some(
                    arch.num_global_key_value_heads.unwrap_or(1)
                        * arch.global_head_dim.unwrap_or(arch.head_dim),
                )
            } else {
                None
            },
            n_global_kv_heads: arch.num_global_key_value_heads,
            global_head_dim: arch.global_head_dim,
            rope_theta: rope.theta,
            rope_type: rope.rope_type.clone(),
            partial_rotary_factor: rope.partial_rotary_factor,
            sliding_window,
            tensors,
        });
    }

    spec
}

fn norm_binding(root: &str, layer: u32, name: &str, role: TensorRole, dim: u32) -> TensorBinding {
    TensorBinding {
        name: format!("{}.layers.{}.{}.weight", root, layer, name),
        role,
        logical_shape: vec![dim],
        packed_shape: None,
    }
}

fn quantized_linear(
    root: &str,
    layer: u32,
    proj_name: &str,
    role: TensorRole,
    out_dim: u32,
    in_dim: u32,
    group_size: u32,
    bits: u32,
) -> TensorBinding {
    let pack = 4 / (bits / 8); // values per u32: 8-bit→4, 4-bit→8, 16-bit→2
    let packed_in = in_dim / pack;
    let n_groups = in_dim / group_size;

    TensorBinding {
        name: format!("{}.layers.{}.{}.weight", root, layer, proj_name),
        role,
        logical_shape: vec![out_dim, in_dim],
        packed_shape: Some(PackedLinearShapes {
            weight: vec![out_dim, packed_in],
            scales: vec![out_dim, n_groups],
            biases: vec![out_dim, n_groups],
            bits,
            group_size,
            groups: n_groups,
        }),
    }
}

// ── Namespace Resolver ─────────────────────────────────────────────────────

/// Anchor tensors that must exist under the text model root.
const ANCHORS: &[&str] = &[
    "embed_tokens.weight",
    "norm.weight",
    "layers.0.input_layernorm.weight",
    "layers.0.self_attn.q_proj.weight",
];

/// Discover the text model namespace by probing candidate prefixes.
/// Candidates are checked in order; first to match all anchors wins.
pub fn resolve_namespace(tensor_names: &[String]) -> Option<NamespaceBinding> {
    let candidates = &["language_model.model", "model"];

    for &candidate in candidates {
        let all_found = ANCHORS.iter().all(|anchor| {
            let full = format!("{}.{}", candidate, anchor);
            tensor_names.iter().any(|n| n == &full)
        });
        if all_found {
            let lm_head_key = format!("{}.lm_head.weight", candidate);
            let embed_key = format!("{}.embed_tokens.weight", candidate);
            let lm_head_exists = tensor_names.iter().any(|n| n == &lm_head_key);
            return Some(NamespaceBinding {
                root: candidate.to_string(),
                discovery: format!("matched {} anchors under '{}'", ANCHORS.len(), candidate),
                lm_head_key: if lm_head_exists {
                    lm_head_key
                } else {
                    embed_key
                },
                lm_head_aliased: !lm_head_exists,
            });
        }
    }
    None
}

// ── Raw JSON parsing to normalized types ───────────────────────────────────

#[derive(Deserialize)]
struct RawConfig {
    #[serde(default)]
    model_type: Option<String>,
    text_config: Option<RawTextConfig>,
    #[serde(default)]
    quantization: Option<RawQuantization>,
    #[serde(default)]
    max_position_embeddings: Option<u32>,
}

#[derive(Deserialize)]
struct RawTextConfig {
    hidden_size: u32,
    intermediate_size: u32,
    num_attention_heads: u32,
    num_key_value_heads: u32,
    head_dim: u32,
    global_head_dim: Option<u32>,
    num_global_key_value_heads: Option<u32>,
    num_hidden_layers: u32,
    vocab_size: u32,
    sliding_window: u32,
    max_position_embeddings: Option<u32>,
    rms_norm_eps: f64,
    tie_word_embeddings: Option<bool>,
    attention_k_eq_v: Option<bool>,
    final_logit_softcapping: Option<f64>,
    hidden_size_per_layer_input: Option<u32>,
    layer_types: Vec<String>,
    rope_parameters: Option<RawRopeParams>,
    model_type: Option<String>,
}

#[derive(Deserialize)]
struct RawRopeParams {
    sliding_attention: Option<RawRopeSpec>,
    full_attention: Option<RawRopeSpec>,
}

#[derive(Deserialize)]
struct RawRopeSpec {
    rope_theta: f64,
    rope_type: Option<String>,
    partial_rotary_factor: Option<f64>,
}

#[derive(Deserialize)]
struct RawQuantization {
    group_size: Option<u32>,
    bits: Option<u32>,
    mode: Option<String>,
}

/// Parse config.json and produce a normalized TextArchitecture + QuantizationMeta.
pub fn parse_config(
    config_path: &str,
) -> napi::Result<(TextArchitecture, Option<QuantizationMeta>, ModelManifest)> {
    let config_json = std::fs::read_to_string(config_path)
        .map_err(|e| napi::Error::from_reason(format!("Cannot read config: {}", e)))?;

    // Hash the raw config for provenance
    let mut hasher = Sha256::new();
    hasher.update(config_json.as_bytes());
    let config_hash = format!("{:x}", hasher.finalize());

    let raw: RawConfig = serde_json::from_str(&config_json)
        .map_err(|e| napi::Error::from_reason(format!("Invalid config JSON: {}", e)))?;

    let text = raw
        .text_config
        .as_ref()
        .ok_or_else(|| napi::Error::from_reason("Missing text_config in model config"))?;

    let max_pos = text
        .max_position_embeddings
        .or(raw.max_position_embeddings)
        .unwrap_or(131072);

    let layer_types: Vec<AttentionKind> = text
        .layer_types
        .iter()
        .map(|s| match s.as_str() {
            "full_attention" => AttentionKind::FullAttention,
            _ => AttentionKind::SlidingAttention,
        })
        .collect();

    if layer_types.len() != text.num_hidden_layers as usize {
        return Err(napi::Error::from_reason(format!(
            "layer_types count ({}) != num_hidden_layers ({})",
            layer_types.len(),
            text.num_hidden_layers
        )));
    }

    let rope_local = {
        let raw_rope = text
            .rope_parameters
            .as_ref()
            .and_then(|r| r.sliding_attention.as_ref())
            .map(|s| RopeSpec {
                theta: s.rope_theta,
                rope_type: s.rope_type.clone().unwrap_or_else(|| "default".into()),
                partial_rotary_factor: s.partial_rotary_factor,
            })
            .unwrap_or_else(|| RopeSpec {
                theta: 10000.0,
                rope_type: "default".into(),
                partial_rotary_factor: None,
            });
        raw_rope
    };

    let rope_global = text
        .rope_parameters
        .as_ref()
        .and_then(|r| r.full_attention.as_ref())
        .map(|s| RopeSpec {
            theta: s.rope_theta,
            rope_type: s.rope_type.clone().unwrap_or_else(|| "proportional".into()),
            partial_rotary_factor: s.partial_rotary_factor,
        });

    let arch = TextArchitecture {
        hidden_size: text.hidden_size,
        intermediate_size: text.intermediate_size,
        num_attention_heads: text.num_attention_heads,
        num_key_value_heads: text.num_key_value_heads,
        head_dim: text.head_dim,
        global_head_dim: text.global_head_dim,
        num_global_key_value_heads: text.num_global_key_value_heads,
        num_hidden_layers: text.num_hidden_layers,
        vocab_size: text.vocab_size,
        sliding_window: text.sliding_window,
        max_position_embeddings: max_pos,
        rms_norm_eps: text.rms_norm_eps,
        tie_word_embeddings: text.tie_word_embeddings.unwrap_or(true),
        attention_k_eq_v: text.attention_k_eq_v.unwrap_or(true),
        final_logit_softcapping: text.final_logit_softcapping,
        hidden_size_per_layer_input: text.hidden_size_per_layer_input.unwrap_or(0),
        layer_types,
        rope_local,
        rope_global,
        model_type: text
            .model_type
            .clone()
            .unwrap_or_else(|| "gemma4_unified_text".into()),
    };

    let q_bits = raw.quantization.as_ref().and_then(|q| q.bits);
    let q_group_size = raw.quantization.as_ref().and_then(|q| q.group_size);
    let quant = raw.quantization.map(|q| QuantizationMeta {
        bits: q.bits.unwrap_or(16),
        group_size: q.group_size.unwrap_or(64),
        mode: match q.mode.as_deref() {
            Some("affine") => QuantizationMode::Affine,
            _ => QuantizationMode::None,
        },
        overrides: HashMap::new(),
    });

    let manifest = ModelManifest {
        config_path: config_path.into(),
        config_hash,
        model_type: raw.model_type.unwrap_or_default(),
        has_text_config: true, // we already checked text_config exists
        has_quantization_metadata: quant.is_some(),
        quantization_bits: q_bits,
        quantization_group_size: q_group_size,
        quantization_mode: quant.as_ref().map(|q| format!("{:?}", q.mode)),
        safetensors_shards: Vec::new(),
    };

    Ok((arch, quant, manifest))
}

// ── Compilation Planning ───────────────────────────────────────────────────

/// Disposition of a tensor in the compiled image.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TensorDisposition {
    /// No physical payload; another tensor is the canonical storage.
    AliasOnly { canonical_tensor_id: u32 },
    /// Bytes copied unchanged into destination segment.
    RelocateAndAlign,
    /// Source bytes can be directly referenced (external-source profile).
    PreserveInPlace,
    /// Small metadata tensor that should be transformed on CPU.
    CpuTransform { recipe: String },
    /// Large data-parallel tensor that should be transformed on GPU.
    GpuTransform { recipe: String },
    /// Tensor participates in Core ML backend island.
    CoreMlLoweringInput,
    /// Not emitted (e.g., unused multimodal wrapper in text-only profile).
    DiscardWithReason { reason: String },
}

/// A single tensor's identity and placement in the compiled image.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedTensor {
    pub id: u32,
    pub name: String,
    pub disposition: TensorDisposition,
    pub source_shard: String,
    pub source_offset: u64,
    pub source_byte_length: u64,
    pub destination_segment: String,
    pub destination_offset: u64,
    pub destination_byte_length: u64,
    pub logical_dtype: String,
    pub logical_shape: Vec<u32>,
}

/// A planned binary segment containing tensors in execution order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedSegment {
    pub id: String,
    pub filename: String,
    pub byte_size: u64,
    pub kind: String,
    pub tensor_count: usize,
}

/// A complete, validated, immutable compilation plan.
/// Produced by the planning phase before any payload emission.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompilationPlan {
    pub model_identity: String,
    pub source_config_hash: String,
    pub source_shard_hashes: Vec<String>,
    pub tensor_table: Vec<PlannedTensor>,
    pub segments: Vec<PlannedSegment>,
    pub total_source_bytes: u64,
    pub total_image_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_layer(index: u32) -> LayerPlan {
        LayerPlan {
            layer_index: index,
            attention_kind: "sliding_attention".into(),
            segment_id: format!("layer_{}", index),
            hidden_size: 64,
            n_heads: 4,
            n_kv_heads: 1,
            head_dim: 16,
            global_head_dim: None,
            n_global_kv_heads: None,
            sliding_window: 4096,
            rope_theta: 10000.0,
            partial_rotary_factor: None,
            attention_k_eq_v: false,
            q_norm_enabled: false,
            k_norm_enabled: false,
            q_proj_tensor_id: 1,
            k_proj_tensor_id: 2,
            v_proj_tensor_id: 3,
            o_proj_tensor_id: 4,
            q_norm_tensor_id: None,
            k_norm_tensor_id: None,
            gate_proj_tensor_id: 5,
            up_proj_tensor_id: 6,
            down_proj_tensor_id: 7,
            input_layernorm_tensor_id: 8,
            post_attention_layernorm_tensor_id: 9,
            pre_ffw_layernorm_tensor_id: None,
            post_ffw_layernorm_tensor_id: None,
            layer_scalar_ids: Vec::new(),
            quantization_ids: Vec::new(),
        }
    }

    fn base_plan() -> ModelExecutionPlan {
        ModelExecutionPlan {
            prologue: ProloguePlan {
                segment_id: "persistent".into(),
                embedding_tensor_id: 10,
                embedding_name: "model.embed_tokens.weight".into(),
                embedding_shape: vec![64, 64],
                embedding_dtype: "U8".into(),
            },
            layers: vec![valid_layer(0)],
            epilogue: EpiloguePlan {
                segment_id: "persistent".into(),
                final_norm_tensor_id: 11,
                final_norm_name: "model.norm.weight".into(),
                output_projection_tensor_id: None,
                output_projection_name: None,
                final_logit_softcapping: None,
                vocab_size: 64,
            },
            hidden_size: 64,
            vocab_size: 64,
            sliding_window: 4096,
            final_logit_softcapping: None,
            tie_word_embeddings: true,
            rms_norm_eps: 1e-6,
        }
    }

    #[test]
    fn validate_rejects_malformed_plans() {
        // 1. Zero layers
        {
            let mut plan = base_plan();
            plan.layers.clear();
            let errs = plan.validate().unwrap_err();
            assert!(
                errs.iter()
                    .any(|e| e.contains("execution plan has zero layers")),
                "expected zero-layers error, got: {:?}",
                errs
            );
        }

        // 2. Layer index mismatch (layer at index 1 has layer_index=0)
        {
            let mut plan = base_plan();
            let mut l1 = valid_layer(1);
            l1.layer_index = 0;
            plan.layers.push(l1);
            let errs = plan.validate().unwrap_err();
            assert!(
                errs.iter().any(|e| e.contains("layer 1 has index 0")),
                "expected index mismatch error, got: {:?}",
                errs
            );
        }

        // 3. Layer hidden_size != model hidden_size
        {
            let mut plan = base_plan();
            plan.layers[0].hidden_size = 128;
            let errs = plan.validate().unwrap_err();
            assert!(
                errs.iter()
                    .any(|e| e.contains("hidden_size") && e.contains("128") && e.contains("64")),
                "expected hidden_size mismatch error, got: {:?}",
                errs
            );
        }

        // 4. q_proj_tensor_id = 0
        {
            let mut plan = base_plan();
            plan.layers[0].q_proj_tensor_id = 0;
            let errs = plan.validate().unwrap_err();
            assert!(
                errs.iter()
                    .any(|e| e.contains("zero q_proj_tensor_id")),
                "expected zero q_proj_tensor_id error, got: {:?}",
                errs
            );
        }

        // 5. full_attention layer missing global_head_dim
        {
            let mut plan = base_plan();
            plan.layers[0].attention_kind = "full_attention".into();
            plan.layers[0].global_head_dim = None;
            // full_attention branch checks global_head_dim, not v_proj
            plan.layers[0].v_proj_tensor_id = 99;
            let errs = plan.validate().unwrap_err();
            assert!(
                errs.iter()
                    .any(|e| e.contains("missing global_head_dim")),
                "expected missing global_head_dim error, got: {:?}",
                errs
            );
        }

        // 6. Unknown attention_kind
        {
            let mut plan = base_plan();
            plan.layers[0].attention_kind = "bogus".into();
            let errs = plan.validate().unwrap_err();
            assert!(
                errs.iter()
                    .any(|e| e.contains("unknown attention_kind: bogus")),
                "expected unknown attention_kind error, got: {:?}",
                errs
            );
        }

        // 7. Prologue with zero embedding_tensor_id
        {
            let mut plan = base_plan();
            plan.prologue.embedding_tensor_id = 0;
            let errs = plan.validate().unwrap_err();
            assert!(
                errs.iter()
                    .any(|e| e.contains("zero embedding_tensor_id")),
                "expected zero embedding_tensor_id error, got: {:?}",
                errs
            );
        }

        // 8. Epilogue with zero final_norm_tensor_id
        {
            let mut plan = base_plan();
            plan.epilogue.final_norm_tensor_id = 0;
            let errs = plan.validate().unwrap_err();
            assert!(
                errs.iter()
                    .any(|e| e.contains("zero final_norm_tensor_id")),
                "expected zero final_norm_tensor_id error, got: {:?}",
                errs
            );
        }
    }
}
