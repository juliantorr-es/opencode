//! Mission 0007 — sidecar generation for execution conditioning.
//!
//! ## Phases
//!
//! * **Phase 2** — Kernel-signature derivation from a [`LayerPlan`].
//! * **Phase 3** — Residency-group derivation from tensor manifests.
//! * **Phase 4** — `ExecutionConditioningSidecar` hashing, identity binding,
//!   and validation against a [`CompiledImageReader`].
//!
//! ## Thread safety
//!
//! Every function in this module is `Send` + `Sync` — no shared mutable
//! state is held across calls.
//!
//! ```
//! use tribunus_evidence_schema::mission0007::{
//!     AttentionKind, DType, KernelSignature, KernelSignatureId,
//!     ResidencyGroup, ResidencyGroupId, ResidencyPlanVersion,
//!     ResidencyPriority, ArtifactRange, ResourceId, OperationFamily,
//!     ConditioningRecipe, ConditioningRecipeId, PipelinePlanVersion,
//!     ConditioningRecipeCompletionState, PhaseShape, SyntheticInputContract,
//!     ScratchKvContract,
//! };

use sha2::{Digest, Sha256};
use std::collections::HashSet;
use uuid::Uuid;

use crate::config::LayerPlan;
use crate::compute_image::CompiledImageReader;
use tribunus_evidence_schema::mission0007::{
    ArtifactRange, AttentionKind, DType, KernelSignature, KernelSignatureId,
    OperationFamily, ResidencyGroup, ResidencyGroupId, ResidencyPlanVersion,
    ResidencyPriority, ResourceId,
};

// ═══════════════════════════════════════════════════════════════════════════
// Dimension helpers
// ═══════════════════════════════════════════════════════════════════════════

/// Standard MLP expansion factor for Gemma 4 decoder layers.
const MLP_EXPANSION: u32 = 4;

/// Quantization parameters shared across all Gemma 4 kernels.
const QUANT_GROUP_SIZE: i32 = 64;
const QUANT_BITS: i32 = 8;

/// Batch dimension for prefill kernels.
const PREFILL_M: i32 = 4;
/// Batch dimension for decode kernels.
const DECODE_M: i32 = 1;

/// Return the output (N) dimension for the attention projection `family`
/// given the layer's geometric parameters.
fn attn_output_dim(
    family: OperationFamily,
    n_heads: u32,
    n_kv_heads: u32,
    head_dim: u32,
    global_head_dim: Option<u32>,
    n_global_kv_heads: Option<u32>,
) -> u32 {
    match family {
        OperationFamily::QProj => {
            let hd = global_head_dim.unwrap_or(head_dim);
            n_heads * hd
        }
        OperationFamily::KProj | OperationFamily::VProj => {
            let hd = global_head_dim.unwrap_or(head_dim);
            let nkv = n_global_kv_heads.unwrap_or(n_kv_heads);
            nkv * hd
        }
        OperationFamily::OProj => {
            // OProj output is always hidden_size.
            unreachable!("caller uses hidden_size for o_proj N");
        }
        _ => unreachable!("not an attention family"),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 — Kernel-signature derivation
// ═══════════════════════════════════════════════════════════════════════════

/// Projection families in execution order for a single decoder layer.
const FAMILIES_IN_ORDER: &[OperationFamily] = &[
    OperationFamily::QProj,
    OperationFamily::KProj,
    OperationFamily::VProj,
    OperationFamily::OProj,
    OperationFamily::GateProj,
    OperationFamily::UpProj,
    OperationFamily::DownProj,
];

/// Derive one [`KernelSignature`] per projection family in `plan` for both
/// prefill (M=4) and decode (M=1) phases.
///
/// Deduplicates identical signatures — two families that produce the same
/// [M, N, K, group_size, bits] are merged into a single entry.
///
/// ## Quantized matmul layout
///
/// The packed weight uses `U32Packed` storage (4 × i8 per u32 cell). Scales
/// are `Bf16` of shape `[N, K / group_size]`; biases are optional `Bf16` of
/// shape `[N]`. Input and output are `F32`.
pub fn derive_kernel_signatures(
    plan: &LayerPlan,
    layer_index: u32,
    _attention_kind: AttentionKind,
) -> Vec<KernelSignature> {
    let hs = plan.hidden_size;
    let n_heads = plan.n_heads;
    let n_kv_heads = plan.n_kv_heads;
    let head_dim = plan.head_dim;
    let global_head_dim = plan.global_head_dim;
    let n_global_kv_heads = plan.n_global_kv_heads;
    let intermediate = hs * MLP_EXPANSION;

    // Common dtypes for all quantized matmul kernels.
    let dtypes = vec![
        DType::U32Packed, // packed weight
        DType::Bf16,      // scales
        DType::Bf16,      // biases
        DType::F32,       // input
        DType::F32,       // output
    ];

    // ── Produce (family, N, K) tuples for every projection ───────────────
    let mut entries: Vec<(OperationFamily, u32, u32)> = Vec::with_capacity(7);

    // Attention projections
    for family in &[OperationFamily::QProj, OperationFamily::KProj, OperationFamily::VProj] {
        let n = attn_output_dim(
            *family,
            n_heads,
            n_kv_heads,
            head_dim,
            global_head_dim,
            n_global_kv_heads,
        );
        entries.push((*family, n, hs));
    }

    // OProj: input = concatenated attention heads, output = hidden_size
    let o_in = attn_output_dim(
        OperationFamily::QProj,
        n_heads,
        n_kv_heads,
        head_dim,
        global_head_dim,
        n_global_kv_heads,
    );
    entries.push((OperationFamily::OProj, hs, o_in));

    // MLP projections
    entries.push((OperationFamily::GateProj, intermediate, hs));
    entries.push((OperationFamily::UpProj, intermediate, hs));
    entries.push((OperationFamily::DownProj, hs, intermediate));

    // ── Generate kernel signatures, deduplicating by shape ───────────────
    let mut seen: HashSet<Vec<i32>> = HashSet::new();
    let mut signatures: Vec<KernelSignature> = Vec::with_capacity(entries.len() * 2);

    let m_values: &[i32] = &[PREFILL_M, DECODE_M];

    for &(family, n, k) in &entries {
        for &m in m_values {
            let shape = vec![m, n as i32, k as i32, QUANT_GROUP_SIZE, QUANT_BITS];
            if seen.contains(&shape) {
                continue;
            }
            seen.insert(shape.clone());

            let kernel_name = format!(
                "quantized_matmul_{}_layer_{}",
                family_name(family),
                layer_index,
            );

            signatures.push(KernelSignature {
                signature_id: KernelSignatureId::from(Uuid::new_v4().to_string()),
                kernel_name,
                dtypes: dtypes.clone(),
                shape,
                validated: false,
            });
        }
    }

    signatures
}

/// Convert an [`OperationFamily`] to its wire-format name without a `_proj`
/// suffix for o_proj (uses `o`)
fn family_name(family: OperationFamily) -> &'static str {
    match family {
        OperationFamily::QProj => "q_proj",
        OperationFamily::KProj => "k_proj",
        OperationFamily::VProj => "v_proj",
        OperationFamily::OProj => "o_proj",
        OperationFamily::GateProj => "gate_proj",
        OperationFamily::UpProj => "up_proj",
        OperationFamily::DownProj => "down_proj",
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 — Residency-group derivation
// ═══════════════════════════════════════════════════════════════════════════

/// System page size in bytes (standard 4 KiB on Apple Silicon).
const PAGE_SIZE: u64 = 4096;

/// Round `offset` down to the nearest page boundary.
fn page_align_down(offset: u64) -> u64 {
    offset & !(PAGE_SIZE - 1)
}

/// Round `(offset + length)` up to the nearest page boundary.
fn page_align_up(offset: u64, length: u64) -> u64 {
    let end = offset + length;
    ((end + PAGE_SIZE - 1) / PAGE_SIZE) * PAGE_SIZE
}

/// Derive a [`ResidencyGroup`] for a single decoder layer.
///
/// Each tensor in `tensor_manifest` contributes two [`ArtifactRange`]s:
///
/// 1. **Unaligned** — the exact byte range described by `(byte_offset, byte_length)`.
/// 2. **Page-aligned** — the offset rounded down and the length rounded up so
///    that the range covers whole pages. This is the range a paging/mapping
///    backend would use to create an `mmap`-friendly region.
///
/// Returns a single [`ResidencyGroup`] containing all artifact ranges for
/// the layer, ordered as (unaligned, page-aligned) pairs per tensor.
pub fn derive_residency_groups(
    _layer_index: u32,
    _attention_kind: AttentionKind,
    tensor_manifest: &[(String, u64, u64)],
) -> ResidencyGroup {
    let mut artifacts: Vec<ArtifactRange> = Vec::with_capacity(tensor_manifest.len() * 2);

    for (tensor_name, byte_offset, byte_length) in tensor_manifest {
        // Unaligned range
        artifacts.push(ArtifactRange {
            resource_id: ResourceId::from(tensor_name.as_str()),
            offset: Some(*byte_offset),
            length: Some(*byte_length),
        });

        // Page-aligned range
        let aligned_offset = page_align_down(*byte_offset);
        let aligned_end = page_align_up(*byte_offset, *byte_length);
        let aligned_length = aligned_end - aligned_offset;
        artifacts.push(ArtifactRange {
            resource_id: ResourceId::from(format!("{}_aligned", tensor_name).as_str()),
            offset: Some(aligned_offset),
            length: Some(aligned_length),
        });
    }

    ResidencyGroup {
        group_id: ResidencyGroupId::from(Uuid::new_v4().to_string()),
        plan_version: ResidencyPlanVersion::from("1.0.0"),
        artifacts,
        priority: ResidencyPriority::Normal,
        evictable: true,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4 — ExecutionConditioningSidecar
// ═══════════════════════════════════════════════════════════════════════════

/// Execution-conditioning sidecar binding kernel signatures, conditioning
/// recipes, residency groups, and the compute-image identity into a single
/// verifiable artifact.
///
/// The sidecar is the unit of conditioning for a single layer: it captures
/// every kernel needed, every tensor residency range, and the identity
/// constraints that must be satisfied before execution begins.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExecutionConditioningSidecar {
    /// SHA-256 of the compiled image this sidecar was derived from.
    pub image_identity: String,
    /// Root path of the compiled artifacts.
    pub artifact_root: String,
    /// SHA-256 digest of the serialized execution plan.
    pub execution_plan_digest: String,
    /// Kernel signatures derived from the execution plan.
    pub kernel_signatures: Vec<KernelSignature>,
    /// Optional conditioning recipes (populated during conditioning).
    pub conditioning_recipes: Vec<tribunus_evidence_schema::mission0007::ConditioningRecipe>,
    /// Residency groups for memory management.
    pub residency_groups: Vec<ResidencyGroup>,
}

impl ExecutionConditioningSidecar {
    /// Construct a new `ExecutionConditioningSidecar`.
    ///
    /// The sidecar is initially empty — `kernel_signatures` and
    /// `residency_groups` are populated by the derivation functions and
    /// the caller is responsible for appending `conditioning_recipes`
    /// during the conditioning phase.
    pub fn new(
        image_identity: String,
        artifact_root: String,
        execution_plan_digest: String,
    ) -> Self {
        Self {
            image_identity,
            artifact_root,
            execution_plan_digest,
            kernel_signatures: Vec::new(),
            conditioning_recipes: Vec::new(),
            residency_groups: Vec::new(),
        }
    }

    /// Compute the identity (SHA-256) of this sidecar.
    ///
    /// Serialises the full struct to JSON (canonical form via
    /// `serde_json::to_vec`) and returns the hexadecimal SHA-256 digest.
    pub fn compute_identity(&self) -> String {
        let serialized = serde_json::to_vec(self).expect("sidecar serialization");
        let mut hasher = Sha256::new();
        hasher.update(&serialized);
        hex::encode(&hasher.finalize())
    }

    /// Validate this sidecar's bindings against a compiled compute image.
    ///
    /// Checks:
    ///
    /// 1. The sidecar's `image_identity` matches the image's `manifest.image_hash`.
    /// 2. The sidecar's `execution_plan_digest` matches the image's
    ///    `receipt.execution_plan_hash`.
    ///
    /// Returns `Ok(())` when all checks pass, or `Err` with a description of
    /// the first violation.
    pub fn validate_bindings(&self, image: &CompiledImageReader) -> Result<(), String> {
        // Check 1: image identity
        if self.image_identity != image.manifest.image_hash {
            return Err(format!(
                "image_identity mismatch: sidecar has '{}', image has '{}'",
                self.image_identity, image.manifest.image_hash,
            ));
        }

        // Check 2: execution plan digest
        if self.execution_plan_digest != image.receipt.execution_plan_hash {
            return Err(format!(
                "execution_plan_digest mismatch: sidecar has '{}', image has '{}'",
                self.execution_plan_digest, image.receipt.execution_plan_hash,
            ));
        }

        Ok(())
    }

    /// Populate kernel signatures by running Phase 2 derivation across
    /// every layer in the execution plan's `ModelExecutionPlan`.
    ///
    /// This is a convenience method that iterates `derive_kernel_signatures`
    /// over all layers in the given plan.
    pub fn derive_all_kernels_from_plan(
        &mut self,
        plan: &crate::config::ModelExecutionPlan,
    ) {
        self.kernel_signatures.clear();

        for layer in &plan.layers {
            let layer_index = layer.layer_index;

            // Convert the string-based attention kind from the plan to the
            // evidence-schema `AttentionKind`.
            let attn_kind = match layer.attention_kind.as_str() {
                "sliding_attention" => AttentionKind::Sliding,
                "full_attention" => AttentionKind::Full,
                other => {
                    // Fallback: treat unknown kinds as sliding (conservative).
                    eprintln!(
                        "sidecar: unknown attention_kind '{}' in layer {}, treating as Sliding",
                        other, layer_index,
                    );
                    AttentionKind::Sliding
                }
            };

            let sigs = derive_kernel_signatures(layer, layer_index, attn_kind);
            self.kernel_signatures.extend(sigs);
        }

        self.execution_plan_digest = compute_plan_digest(plan);
    }
}

/// Compute a SHA-256 digest of a [`ModelExecutionPlan`] by serialising it
/// to JSON (canonical form) and hashing the bytes.
fn compute_plan_digest(plan: &crate::config::ModelExecutionPlan) -> String {
    let serialized = serde_json::to_vec(plan).expect("plan serialization");
    let mut hasher = Sha256::new();
    hasher.update(&serialized);
    hex::encode(&hasher.finalize())
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/// Minimal hex-encoding helper (avoids pulling in the `hex` crate).
mod hex {
    /// Encode a byte slice as a lowercase hex string.
    pub fn encode(bytes: &[u8]) -> String {
        const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(bytes.len() * 2);
        for &b in bytes {
            out.push(HEX_CHARS[(b >> 4) as usize] as char);
            out.push(HEX_CHARS[(b & 0x0f) as usize] as char);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify that `hex::encode` produces lowercase hexadecimal.
    #[test]
    fn hex_encode_basic() {
        assert_eq!(hex::encode(&[0x00]), "00");
        assert_eq!(hex::encode(&[0xff]), "ff");
        assert_eq!(hex::encode(&[0xab, 0xcd]), "abcd");
        assert_eq!(hex::encode(b"hello"), "68656c6c6f");
    }
}
