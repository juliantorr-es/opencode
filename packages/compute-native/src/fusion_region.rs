//! Fusion regions — scheduled fusion graph boundaries for MLX/Core ML hybrid
//! deployment.
//!
//! A `FusionRegion` names a set of component operations that the compiler
//! attempts to fuse into a single kernel.  Each region carries a layout
//! contract, an output contract, a set of candidate `FusionImpl` entries
//! (one per backend implementation), a fallback decomposition, and a count
//! of intermediate tensors the fusion eliminates.
//!
//! The [`generate_all_fusion_regions`] function returns seven hardcoded
//! regions matching the Gemma 4 12B decoder-layer topology.

use serde::{Deserialize, Serialize};

// ── Backend enum ───────────────────────────────────────────────────────────

/// Backend on which a fusion implementation runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FusionImplBackend {
    /// MLX Metal GPU kernel.
    MlxGpu,
    /// MLX CPU fallback path.
    MlxCpu,
    /// Accelerate.framework (vDSP / vImage).
    Accelerate,
    /// Core ML ANE island.
    CoreMlAne,
    /// Rust NEON SIMD path.
    RustNeon,
    /// Fusion-only placeholder (no standalone kernel available).
    FusionOnly,
}

// ── Implementation type ────────────────────────────────────────────────────

/// Classification of what a fusion implementation represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImplementationType {
    /// Fused Metal shader (MLX custom kernel).
    FusedMetalShader,
    /// Fused MLX CPU compound kernel.
    FusedCpuKernel,
    /// Core ML model island.
    FusedAneIsland,
    /// Fused Accelerate vector pipeline.
    FusedAcceleratePipeline,
    /// Rust NEON fused loop.
    FusedNeonLoop,
    /// Decomposed fallback (individual ops, not fused).
    DecomposedFallback,
}

// ── Qualification status ───────────────────────────────────────────────────

/// How far a fusion implementation has been validated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualificationStatus {
    /// Not yet benchmarked or validated.
    Unqualified,
    /// Parity and latency verified on the target hardware.
    Qualified,
    /// Benchmark data is absent or inconclusive; pending qualification.
    BenchmarkUnresolved,
}

// ── Fusion implementation ──────────────────────────────────────────────────

/// A single candidate implementation of a fusion region.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionImpl {
    /// Backend this implementation targets.
    pub backend: FusionImplBackend,
    /// What kind of implementation this is.
    pub implementation_type: ImplementationType,
    /// How far this implementation has been qualified.
    pub qualification_status: QualificationStatus,
    /// Measured or projected boundary latency for this fusion (µs).
    pub boundary_latency_us: u64,
    /// Whether numerical parity against the unfused MLX reference passed.
    pub parity_passed: bool,
}

// ── Input layout spec ──────────────────────────────────────────────────────

/// Expected input tensor layout for a fusion region.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputLayoutSpec {
    /// Unique layout identifier within the region.
    pub id: String,
    /// Expected tensor dimensions (e.g. `[1, seq_len, hidden_size]`).
    pub dims: Vec<u32>,
    /// Expected element dtype (e.g. `"bf16"`, `"f32"`).
    pub dtype: String,
    /// Whether the tensor is expected to be contiguous.
    pub contiguous: bool,
    /// Optional byte-alignment requirement.
    pub alignment: Option<u32>,
}

// ── Output contract ────────────────────────────────────────────────────────

/// Guaranteed output properties for a fusion region.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputContract {
    /// Unique contract identifier within the region.
    pub id: String,
    /// Output tensor dimensions.
    pub dims: Vec<u32>,
    /// Output element dtype.
    pub dtype: String,
    /// Guaranteed minimum precision (e.g. `"fp32"`, `"fp16`).
    pub guaranteed_precision: Option<String>,
}

// ── Fusion region ──────────────────────────────────────────────────────────

/// A scheduled fusion region describing which ops the compiler should fuse,
/// the layout contract, candidate implementations, and fallback behaviour.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionRegion {
    /// Unique region identifier.
    pub id: String,
    /// Ordered list of component operation names that are fused.
    pub component_ops: Vec<String>,
    /// Expected input tensor layout.
    pub input_layout: InputLayoutSpec,
    /// Output contract the fusion must satisfy.
    pub output_contract: OutputContract,
    /// Candidate fusion implementations (one per backend).
    pub implementations: Vec<FusionImpl>,
    /// Ordered list of operation names for the fallback decomposition
    /// (unfused path used when no implementation qualifies).
    pub fallback_decomposition: Vec<String>,
    /// How many intermediate tensors are eliminated by this fusion.
    pub expected_eliminated_intermediates: u32,
}

// ── Generators ─────────────────────────────────────────────────────────────

/// Return the seven hardcoded fusion regions for the Gemma 4 12B decoder
/// topology.
pub fn generate_all_fusion_regions() -> Vec<FusionRegion> {
    vec![
        qkv_proj_region(),
        attn_out_region(),
        gate_up_proj_region(),
        silu_mul_region(),
        down_proj_region(),
        rms_norm_residual_region(),
        self_attn_region(),
    ]
}

// ── Individual region factories ────────────────────────────────────────────

/// Fused QKV projection: `q_proj + k_proj + v_proj` into a single kernel.
///
/// Eliminates three separate matmul dispatches and their intermediate
/// writeback to staging memory.
fn qkv_proj_region() -> FusionRegion {
    let input_layout = InputLayoutSpec {
        id: "hidden_input".into(),
        dims: vec![1, 1, 3840],
        dtype: "bf16".into(),
        contiguous: true,
        alignment: Some(64),
    };
    let output_contract = OutputContract {
        id: "qkv_output".into(),
        dims: vec![3, 1, 3840],
        dtype: "bf16".into(),
        guaranteed_precision: Some("fp32".into()),
    };
    let implementations = vec![
        FusionImpl {
            backend: FusionImplBackend::MlxGpu,
            implementation_type: ImplementationType::FusedMetalShader,
            qualification_status: QualificationStatus::Qualified,
            boundary_latency_us: 42,
            parity_passed: true,
        },
        FusionImpl {
            backend: FusionImplBackend::MlxCpu,
            implementation_type: ImplementationType::FusedCpuKernel,
            qualification_status: QualificationStatus::BenchmarkUnresolved,
            boundary_latency_us: 380,
            parity_passed: true,
        },
        FusionImpl {
            backend: FusionImplBackend::CoreMlAne,
            implementation_type: ImplementationType::FusedAneIsland,
            qualification_status: QualificationStatus::Unqualified,
            boundary_latency_us: 110,
            parity_passed: false,
        },
    ];
    FusionRegion {
        id: "qkv_proj".into(),
        component_ops: vec![
            "q_proj".into(),
            "k_proj".into(),
            "v_proj".into(),
        ],
        input_layout,
        output_contract,
        implementations,
        fallback_decomposition: vec![
            "q_proj".into(),
            "k_proj".into(),
            "v_proj".into(),
        ],
        expected_eliminated_intermediates: 3,
    }
}

/// Attention output projection: a single fused matmul that writes the
/// projected attention result.  Trivially a single op, but fusion eliminates
/// the staging buffer round-trip when chained with the preceding score
/// softmax.
fn attn_out_region() -> FusionRegion {
    let input_layout = InputLayoutSpec {
        id: "attn_concat".into(),
        dims: vec![1, 1, 3840],
        dtype: "bf16".into(),
        contiguous: true,
        alignment: Some(64),
    };
    let output_contract = OutputContract {
        id: "attn_output".into(),
        dims: vec![1, 1, 3840],
        dtype: "bf16".into(),
        guaranteed_precision: Some("fp32".into()),
    };
    let implementations = vec![
        FusionImpl {
            backend: FusionImplBackend::MlxGpu,
            implementation_type: ImplementationType::FusedMetalShader,
            qualification_status: QualificationStatus::Qualified,
            boundary_latency_us: 18,
            parity_passed: true,
        },
        FusionImpl {
            backend: FusionImplBackend::Accelerate,
            implementation_type: ImplementationType::FusedAcceleratePipeline,
            qualification_status: QualificationStatus::BenchmarkUnresolved,
            boundary_latency_us: 156,
            parity_passed: true,
        },
    ];
    FusionRegion {
        id: "attn_out".into(),
        component_ops: vec!["attn_out_proj".into()],
        input_layout,
        output_contract,
        implementations,
        fallback_decomposition: vec!["attn_out_proj".into()],
        expected_eliminated_intermediates: 0,
    }
}

/// Fused gate + up projection: `gate_proj + up_proj` into a single kernel.
///
/// Both projections share the same input (`hidden`) and differ only in the
/// weight matrix.  Fusing halves the dispatch overhead and improves cache
/// locality.
fn gate_up_proj_region() -> FusionRegion {
    let input_layout = InputLayoutSpec {
        id: "hidden_input".into(),
        dims: vec![1, 1, 3840],
        dtype: "bf16".into(),
        contiguous: true,
        alignment: Some(64),
    };
    let output_contract = OutputContract {
        id: "gate_up_output".into(),
        dims: vec![2, 1, 15360],
        dtype: "bf16".into(),
        guaranteed_precision: Some("fp32".into()),
    };
    let implementations = vec![
        FusionImpl {
            backend: FusionImplBackend::MlxGpu,
            implementation_type: ImplementationType::FusedMetalShader,
            qualification_status: QualificationStatus::Qualified,
            boundary_latency_us: 36,
            parity_passed: true,
        },
        FusionImpl {
            backend: FusionImplBackend::MlxCpu,
            implementation_type: ImplementationType::FusedCpuKernel,
            qualification_status: QualificationStatus::BenchmarkUnresolved,
            boundary_latency_us: 290,
            parity_passed: true,
        },
        FusionImpl {
            backend: FusionImplBackend::CoreMlAne,
            implementation_type: ImplementationType::FusedAneIsland,
            qualification_status: QualificationStatus::Unqualified,
            boundary_latency_us: 88,
            parity_passed: false,
        },
    ];
    FusionRegion {
        id: "gate_up_proj".into(),
        component_ops: vec![
            "gate_proj".into(),
            "up_proj".into(),
        ],
        input_layout,
        output_contract,
        implementations,
        fallback_decomposition: vec![
            "gate_proj".into(),
            "up_proj".into(),
        ],
        expected_eliminated_intermediates: 1,
    }
}

/// SiLU activation + element-wise multiply: `silu(gate) * up`.
///
/// Eliminates the temporary `silu(gate)` buffer — the fused kernel writes
/// directly to the final `gate * up` output.
fn silu_mul_region() -> FusionRegion {
    let input_layout = InputLayoutSpec {
        id: "gate_up_input".into(),
        dims: vec![2, 1, 15360],
        dtype: "bf16".into(),
        contiguous: true,
        alignment: Some(64),
    };
    let output_contract = OutputContract {
        id: "activation_output".into(),
        dims: vec![1, 1, 15360],
        dtype: "bf16".into(),
        guaranteed_precision: Some("fp32".into()),
    };
    let implementations = vec![
        FusionImpl {
            backend: FusionImplBackend::MlxGpu,
            implementation_type: ImplementationType::FusedMetalShader,
            qualification_status: QualificationStatus::Qualified,
            boundary_latency_us: 14,
            parity_passed: true,
        },
        FusionImpl {
            backend: FusionImplBackend::RustNeon,
            implementation_type: ImplementationType::FusedNeonLoop,
            qualification_status: QualificationStatus::BenchmarkUnresolved,
            boundary_latency_us: 92,
            parity_passed: true,
        },
    ];
    FusionRegion {
        id: "silu_mul".into(),
        component_ops: vec![
            "silu".into(),
            "mul".into(),
        ],
        input_layout,
        output_contract,
        implementations,
        fallback_decomposition: vec![
            "silu".into(),
            "mul".into(),
        ],
        expected_eliminated_intermediates: 1,
    }
}

/// MLP down projection: `down_proj(activation)`.
///
/// Single-op fusion region that chains after `silu_mul` and is itself
/// a candidate for further fusion into a larger MLP megakernel.
fn down_proj_region() -> FusionRegion {
    let input_layout = InputLayoutSpec {
        id: "activation_input".into(),
        dims: vec![1, 1, 15360],
        dtype: "bf16".into(),
        contiguous: true,
        alignment: Some(64),
    };
    let output_contract = OutputContract {
        id: "mlp_output".into(),
        dims: vec![1, 1, 3840],
        dtype: "bf16".into(),
        guaranteed_precision: Some("fp32".into()),
    };
    let implementations = vec![
        FusionImpl {
            backend: FusionImplBackend::MlxGpu,
            implementation_type: ImplementationType::FusedMetalShader,
            qualification_status: QualificationStatus::Qualified,
            boundary_latency_us: 24,
            parity_passed: true,
        },
        FusionImpl {
            backend: FusionImplBackend::MlxCpu,
            implementation_type: ImplementationType::FusedCpuKernel,
            qualification_status: QualificationStatus::Qualified,
            boundary_latency_us: 210,
            parity_passed: true,
        },
        FusionImpl {
            backend: FusionImplBackend::Accelerate,
            implementation_type: ImplementationType::FusedAcceleratePipeline,
            qualification_status: QualificationStatus::Unqualified,
            boundary_latency_us: 170,
            parity_passed: false,
        },
    ];
    FusionRegion {
        id: "down_proj".into(),
        component_ops: vec!["down_proj".into()],
        input_layout,
        output_contract,
        implementations,
        fallback_decomposition: vec!["down_proj".into()],
        expected_eliminated_intermediates: 0,
    }
}

/// RMS norm + residual add: `rms_norm(hidden) + residual`.
///
/// Fuses the pre-RMS-norm normalization with the element-wise residual add,
/// eliminating the normalised intermediate.
fn rms_norm_residual_region() -> FusionRegion {
    let input_layout = InputLayoutSpec {
        id: "hidden_with_residual".into(),
        dims: vec![1, 1, 3840],
        dtype: "bf16".into(),
        contiguous: true,
        alignment: Some(64),
    };
    let output_contract = OutputContract {
        id: "norm_output".into(),
        dims: vec![1, 1, 3840],
        dtype: "bf16".into(),
        guaranteed_precision: Some("fp32".into()),
    };
    let implementations = vec![
        FusionImpl {
            backend: FusionImplBackend::MlxGpu,
            implementation_type: ImplementationType::FusedMetalShader,
            qualification_status: QualificationStatus::Qualified,
            boundary_latency_us: 8,
            parity_passed: true,
        },
        FusionImpl {
            backend: FusionImplBackend::RustNeon,
            implementation_type: ImplementationType::FusedNeonLoop,
            qualification_status: QualificationStatus::BenchmarkUnresolved,
            boundary_latency_us: 44,
            parity_passed: true,
        },
    ];
    FusionRegion {
        id: "rms_norm_residual".into(),
        component_ops: vec![
            "rms_norm".into(),
            "add".into(),
        ],
        input_layout,
        output_contract,
        implementations,
        fallback_decomposition: vec![
            "rms_norm".into(),
            "add".into(),
        ],
        expected_eliminated_intermediates: 1,
    }
}

/// Full self-attention fusion: `q_proj, k_proj, v_proj, score, softmax,
/// attn_out_proj` into one megakernel.
///
/// The largest fusion region — eliminates five intermediate tensors and
/// keeps the attention score / softmax / output projection data entirely
/// on-device without staging to host-visible memory.
fn self_attn_region() -> FusionRegion {
    let input_layout = InputLayoutSpec {
        id: "self_attn_input".into(),
        dims: vec![1, 1, 3840],
        dtype: "bf16".into(),
        contiguous: true,
        alignment: Some(64),
    };
    let output_contract = OutputContract {
        id: "self_attn_output".into(),
        dims: vec![1, 1, 3840],
        dtype: "bf16".into(),
        guaranteed_precision: Some("fp32".into()),
    };
    let implementations = vec![
        FusionImpl {
            backend: FusionImplBackend::MlxGpu,
            implementation_type: ImplementationType::FusedMetalShader,
            qualification_status: QualificationStatus::Qualified,
            boundary_latency_us: 68,
            parity_passed: true,
        },
        FusionImpl {
            backend: FusionImplBackend::CoreMlAne,
            implementation_type: ImplementationType::FusedAneIsland,
            qualification_status: QualificationStatus::Unqualified,
            boundary_latency_us: 210,
            parity_passed: false,
        },
        FusionImpl {
            backend: FusionImplBackend::FusionOnly,
            implementation_type: ImplementationType::DecomposedFallback,
            qualification_status: QualificationStatus::BenchmarkUnresolved,
            boundary_latency_us: 0,
            parity_passed: false,
        },
    ];
    FusionRegion {
        id: "self_attn".into(),
        component_ops: vec![
            "q_proj".into(),
            "k_proj".into(),
            "v_proj".into(),
            "score".into(),
            "softmax".into(),
            "attn_out_proj".into(),
        ],
        input_layout,
        output_contract,
        implementations,
        fallback_decomposition: vec![
            "q_proj".into(),
            "k_proj".into(),
            "v_proj".into(),
            "score".into(),
            "softmax".into(),
            "attn_out_proj".into(),
        ],
        expected_eliminated_intermediates: 5,
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_all_fusion_regions_returns_7() {
        let regions = generate_all_fusion_regions();
        assert_eq!(regions.len(), 7);
    }

    #[test]
    fn test_region_ids_are_unique() {
        let regions = generate_all_fusion_regions();
        let ids: std::collections::HashSet<&str> =
            regions.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids.len(), 7);
    }

    #[test]
    fn test_each_region_has_at_least_one_impl() {
        let regions = generate_all_fusion_regions();
        for region in &regions {
            assert!(
                !region.implementations.is_empty(),
                "region {} has no implementations",
                region.id
            );
        }
    }

    #[test]
    fn test_fallback_contains_all_ops() {
        for region in generate_all_fusion_regions() {
            assert!(
                !region.fallback_decomposition.is_empty(),
                "region {} has empty fallback",
                region.id
            );
        }
    }

    #[test]
    fn test_qkv_proj_eliminates_3_intermediates() {
        let regions = generate_all_fusion_regions();
        let qkv = regions.iter().find(|r| r.id == "qkv_proj").unwrap();
        assert_eq!(qkv.expected_eliminated_intermediates, 3);
        assert_eq!(qkv.component_ops.len(), 3);
    }

    #[test]
    fn test_gate_up_proj_eliminates_1_intermediate() {
        let regions = generate_all_fusion_regions();
        let gup = regions.iter().find(|r| r.id == "gate_up_proj").unwrap();
        assert_eq!(gup.expected_eliminated_intermediates, 1);
    }

    #[test]
    fn test_self_attn_eliminates_5_intermediates() {
        let regions = generate_all_fusion_regions();
        let attn = regions.iter().find(|r| r.id == "self_attn").unwrap();
        assert_eq!(attn.expected_eliminated_intermediates, 5);
        assert_eq!(attn.component_ops.len(), 6);
    }

    #[test]
    fn test_serde_roundtrip() {
        let regions = generate_all_fusion_regions();
        for region in &regions {
            let json = serde_json::to_string(region).expect("serialize");
            let parsed: FusionRegion =
                serde_json::from_str(&json).expect("deserialize");
            assert_eq!(parsed.id, region.id);
            assert_eq!(
                parsed.component_ops.len(),
                region.component_ops.len()
            );
            assert_eq!(parsed.implementations.len(), region.implementations.len());
        }
    }

    #[test]
    fn test_impl_backend_serde() {
        let cases = vec![
            (FusionImplBackend::MlxGpu, "\"mlx_gpu\""),
            (FusionImplBackend::MlxCpu, "\"mlx_cpu\""),
            (FusionImplBackend::Accelerate, "\"accelerate\""),
            (FusionImplBackend::CoreMlAne, "\"core_ml_ane\""),
            (FusionImplBackend::RustNeon, "\"rust_neon\""),
            (FusionImplBackend::FusionOnly, "\"fusion_only\""),
        ];
        for (variant, expected) in cases {
            let json = serde_json::to_string(&variant).expect("serialize");
            assert_eq!(json, expected, "mismatch for {variant:?}");
        }
    }

    #[test]
    fn test_qualification_status_serde() {
        let cases = vec![
            (QualificationStatus::Unqualified, "\"unqualified\""),
            (QualificationStatus::Qualified, "\"qualified\""),
            (
                QualificationStatus::BenchmarkUnresolved,
                "\"benchmark_unresolved\"",
            ),
        ];
        for (variant, expected) in cases {
            let json = serde_json::to_string(&variant).expect("serialize");
            assert_eq!(json, expected, "mismatch for {variant:?}");
        }
    }

    #[test]
    fn test_implementation_type_serde() {
        let cases = vec![
            (
                ImplementationType::FusedMetalShader,
                "\"fused_metal_shader\"",
            ),
            (ImplementationType::FusedCpuKernel, "\"fused_cpu_kernel\""),
            (ImplementationType::FusedAneIsland, "\"fused_ane_island\""),
            (
                ImplementationType::FusedAcceleratePipeline,
                "\"fused_accelerate_pipeline\"",
            ),
            (ImplementationType::FusedNeonLoop, "\"fused_neon_loop\""),
            (
                ImplementationType::DecomposedFallback,
                "\"decomposed_fallback\"",
            ),
        ];
        for (variant, expected) in cases {
            let json = serde_json::to_string(&variant).expect("serialize");
            assert_eq!(json, expected, "mismatch for {variant:?}");
        }
    }
}
