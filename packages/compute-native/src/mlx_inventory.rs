//! MLX fork primitive inventory — documents every forked kernel, its Metal
//! backend file, and the divergence from upstream mlx.
//!
//! This module is purely descriptive: it holds hardcoded metadata tables
//! that the compute pipeline, compiler, and runtime consult to understand
//! which MLX primitives are available, how they dispatch, and what
//! fork-specific patches they carry.

use serde::Serialize;

// ── Supported dtypes ───────────────────────────────────────────────────────
// ── Supported dtypes
/// Dtype classification used in dispatch conditions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[allow(non_camel_case_types)]
pub enum DtypeFlag {
    Float16,
    Float32,
    BFloat16,
    Int8,
    Int16,
    Int32,
    Uint8,
    Uint32,
    Uint64,
}

// ── Contiguity ─────────────────────────────────────────────────────────────

/// Contiguity requirements for a primitive's inputs.
#[derive(Debug, Clone, Serialize)]
pub struct ContiguityReqs {
    /// True when all inputs must be row-major contiguous.
    pub all_contiguous: bool,
    /// Index of the singular reduction dimension or `None`.
    pub reduce_dim: Option<usize>,
    /// True when batch dimensions must be contiguous.
    pub batch_contiguous: bool,
}

// ── Alignment ──────────────────────────────────────────────────────────────

/// Alignment and stride constraints.
#[derive(Debug, Clone, Serialize)]
pub struct Alignment {
    /// Byte alignment for input pointers (0 = no constraint).
    pub input_align: u32,
    /// Byte alignment for output pointers (0 = no constraint).
    pub output_align: u32,
    /// Minimum vectorized stride multiple (1 = no constraint).
    pub stride_multiple: u32,
}

// ── Temp buffer ────────────────────────────────────────────────────────────

/// Temporary buffer policy for a primitive.
#[derive(Debug, Clone, Serialize)]
pub struct TempBuffer {
    /// Whether the primitive requires a temporary scratch buffer.
    pub required: bool,
    /// Estimated per-element byte ratio (bytes / element) or 0 if dynamic.
    pub per_element: f32,
    /// Fixed minimum allocation in bytes.
    pub fixed_min: u32,
}

// ── Sync ───────────────────────────────────────────────────────────────────

/// Synchronisation requirements after dispatch.
#[derive(Debug, Clone, Serialize)]
pub struct Sync {
    /// True when a GPU sync (wait for completion) is required after this kernel.
    pub gpu_sync_required: bool,
    /// True when the host must fence before reading output.
    pub host_fence: bool,
}

// ── Dispatch condition ─────────────────────────────────────────────────────

/// Runtime condition that gates which kernel variant is selected.
#[derive(Debug, Clone, Serialize)]
pub struct DispatchCondition {
    /// Human-readable condition description.
    pub condition: &'static str,
    /// Kernel variant tag (e.g. "split_k_4", "qmv_nt").
    pub variant: &'static str,
    /// Order of precedence (lower = checked first).
    pub precedence: u16,
}

// ── MlxPrimitive ───────────────────────────────────────────────────────────

/// Complete description of one MLX fork primitive.
#[derive(Debug, Clone, Serialize)]
pub struct MlxPrimitive {
    /// Public op name as exposed to the model graph (e.g. "quantized_matmul").
    pub public_op: &'static str,
    /// C-level primitive function name (e.g. "mlx_quantized_matmul").
    pub c_primitive: &'static str,
    /// Relative path to the Metal shader source file.
    pub metal_backend_file: &'static str,
    /// Kernel family tag for grouping related kernels.
    pub kernel_family: &'static str,
    /// Dispatch condition table — ordered by precedence.
    pub dispatch_conditions: &'static [DispatchCondition],
    /// dtypes this primitive supports natively.
    pub supported_dtypes: &'static [DtypeFlag],
    /// Contiguity requirements for the primitive.
    pub contiguity_reqs: ContiguityReqs,
    /// Alignment and stride constraints.
    pub alignment: Alignment,
    /// Temporary buffer policy.
    pub temp_buffer: TempBuffer,
    /// Synchronisation requirements.
    pub sync: Sync,
    /// True when this primitive qualifies for the pre-compilation pipeline.
    pub compile_eligible: bool,
}

// ── Fork divergence ────────────────────────────────────────────────────────

/// One documented divergence between our fork and upstream mlx.
#[derive(Debug, Clone, Serialize)]
pub struct ForkDivergence {
    /// Human-readable area name (e.g. "external_array", "quantized_api").
    pub area: &'static str,
    /// Divergence identifier, unique per area.
    pub id: &'static str,
    /// Short description of the difference.
    pub description: &'static str,
    /// True when this divergence is an extension (added API), false when a patch.
    pub is_extension: bool,
}

// ── Hardcoded dispatch conditions ───────────────────────────────────────────

const QMV_DISPATCH: &[DispatchCondition] = &[
    DispatchCondition {
        condition: "M == 1 && transposed == false",
        variant: "qmv_nt",
        precedence: 10,
    },
    DispatchCondition {
        condition: "M == 1 && transposed == true",
        variant: "qmv_t",
        precedence: 10,
    },
    DispatchCondition {
        condition: "M > 1 && transposed == false",
        variant: "qvm_nt",
        precedence: 20,
    },
    DispatchCondition {
        condition: "M > 1 && transposed == true",
        variant: "qvm_t",
        precedence: 20,
    },
];

const SPLIT_K_DISPATCH: &[DispatchCondition] = &[
    DispatchCondition {
        condition: "split_k == 4",
        variant: "split_k_4",
        precedence: 5,
    },
    DispatchCondition {
        condition: "split_k == 8",
        variant: "split_k_8",
        precedence: 5,
    },
];

const RMS_NORM_DISPATCH: &[DispatchCondition] = &[
    DispatchCondition {
        condition: "eps != 0.0 && weight != None",
        variant: "learned",
        precedence: 10,
    },
    DispatchCondition {
        condition: "eps != 0.0 && weight == None",
        variant: "scale_free",
        precedence: 10,
    },
];

const ROPE_DISPATCH: &[DispatchCondition] = &[
    DispatchCondition {
        condition: "partial_factor == None",
        variant: "full",
        precedence: 10,
    },
    DispatchCondition {
        condition: "partial_factor != None",
        variant: "partial",
        precedence: 20,
    },
];

const SOFTMAX_DISPATCH: &[DispatchCondition] = &[
    DispatchCondition {
        condition: "axis == -1",
        variant: "vanilla",
        precedence: 10,
    },
    DispatchCondition {
        condition: "axis != -1",
        variant: "axis",
        precedence: 20,
    },
];

const SILU_DISPATCH: &[DispatchCondition] = &[DispatchCondition {
    condition: "always",
    variant: "elementwise",
    precedence: 10,
}];

const INDEXING_DISPATCH: &[DispatchCondition] = &[
    DispatchCondition {
        condition: "rank(&indices) == 1",
        variant: "gather_1d",
        precedence: 10,
    },
    DispatchCondition {
        condition: "rank(&indices) == 2",
        variant: "gather_2d",
        precedence: 20,
    },
    DispatchCondition {
        condition: "rank(&indices) > 2",
        variant: "gather_nd",
        precedence: 30,
    },
];

// ── Primitive catalogue
// ── New dispatch condition tables ───────────────────────────────────────────

const RESIDUAL_ADD_DISPATCH: &[DispatchCondition] = &[DispatchCondition {
    condition: "always",
    variant: "elementwise",
    precedence: 10,
}];

const BROADCAST_RESHAPE_DISPATCH: &[DispatchCondition] = &[DispatchCondition {
    condition: "always",
    variant: "general",
    precedence: 10,
}];

const CONCATENATE_DISPATCH: &[DispatchCondition] = &[
    DispatchCondition {
        condition: "axis == 0",
        variant: "axis_0",
        precedence: 10,
    },
    DispatchCondition {
        condition: "axis != 0",
        variant: "axis_other",
        precedence: 20,
    },
];

const DTYPE_CAST_DISPATCH: &[DispatchCondition] = &[DispatchCondition {
    condition: "always",
    variant: "general",
    precedence: 10,
}];

const CONTIGUOUS_COPY_DISPATCH: &[DispatchCondition] = &[DispatchCondition {
    condition: "always",
    variant: "general",
    precedence: 10,
}];

const ARGMAX_DISPATCH: &[DispatchCondition] = &[
    DispatchCondition {
        condition: "axis == -1",
        variant: "last_axis",
        precedence: 10,
    },
    DispatchCondition {
        condition: "axis != -1",
        variant: "general_axis",
        precedence: 20,
    },
];

const TOPK_DISPATCH: &[DispatchCondition] = &[
    DispatchCondition {
        condition: "k <= 32",
        variant: "small_k",
        precedence: 10,
    },
    DispatchCondition {
        condition: "k > 32",
        variant: "large_k",
        precedence: 20,
    },
];

const CACHE_UPDATE_DISPATCH: &[DispatchCondition] = &[DispatchCondition {
    condition: "always",
    variant: "general",
    precedence: 10,
}];

/// Every forked MLX primitive known to the Tribunus compute kernel.
///
/// When adding a new primitive, insert it here with accurate dispatch,
/// alignment, and sync metadata so the compiler and runtime can reason
/// about it without hardcoding kernel details.
const PRIMITIVES: &[MlxPrimitive] = &[
    // ── Quantised matmul ────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "quantized_matmul",
        c_primitive: "mlx_quantized_matmul",
        metal_backend_file: "mlx/backend/metal/kernels/quantized.metal",
        kernel_family: "qmv",
        dispatch_conditions: QMV_DISPATCH,
        supported_dtypes: &[DtypeFlag::Float16, DtypeFlag::BFloat16],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: true,
            reduce_dim: None,
            batch_contiguous: true,
        },
        alignment: Alignment {
            input_align: 16,
            output_align: 16,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
    // ── Quantised matmul (split-k) ───────────────────────────────────────
    MlxPrimitive {
        public_op: "quantized_matmul",
        c_primitive: "mlx_quantized_matmul_split_k",
        metal_backend_file: "mlx/backend/metal/kernels/quantized.metal",
        kernel_family: "split_k",
        dispatch_conditions: SPLIT_K_DISPATCH,
        supported_dtypes: &[DtypeFlag::Float16, DtypeFlag::BFloat16],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: true,
            reduce_dim: None,
            batch_contiguous: true,
        },
        alignment: Alignment {
            input_align: 16,
            output_align: 16,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: true,
            per_element: 0.0,
            fixed_min: 65536,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
    // ── RMS norm ─────────────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "rms_norm",
        c_primitive: "mlx_rms_norm",
        metal_backend_file: "mlx/backend/metal/kernels/norm.metal",
        kernel_family: "rms_norm",
        dispatch_conditions: RMS_NORM_DISPATCH,
        supported_dtypes: &[DtypeFlag::Float16, DtypeFlag::BFloat16, DtypeFlag::Float32],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: false,
            reduce_dim: Some(1),
            batch_contiguous: false,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
    // ── RoPE ─────────────────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "rope",
        c_primitive: "mlx_rope",
        metal_backend_file: "mlx/backend/metal/kernels/rope.metal",
        kernel_family: "rope",
        dispatch_conditions: ROPE_DISPATCH,
        supported_dtypes: &[DtypeFlag::Float16, DtypeFlag::BFloat16, DtypeFlag::Float32],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: false,
            reduce_dim: None,
            batch_contiguous: true,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
    // ── Softmax ──────────────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "softmax",
        c_primitive: "mlx_softmax",
        metal_backend_file: "mlx/backend/metal/kernels/softmax.metal",
        kernel_family: "softmax",
        dispatch_conditions: SOFTMAX_DISPATCH,
        supported_dtypes: &[DtypeFlag::Float16, DtypeFlag::BFloat16, DtypeFlag::Float32],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: false,
            reduce_dim: Some(1),
            batch_contiguous: true,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: true,
        },
        compile_eligible: true,
    },
    // ── SiLU ─────────────────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "silu",
        c_primitive: "mlx_silu",
        metal_backend_file: "mlx/backend/metal/kernels/activations.metal",
        kernel_family: "silu",
        dispatch_conditions: SILU_DISPATCH,
        supported_dtypes: &[DtypeFlag::Float16, DtypeFlag::BFloat16, DtypeFlag::Float32],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: false,
            reduce_dim: None,
            batch_contiguous: false,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
    // ── Indexing (gather) ────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "indexing",
        c_primitive: "mlx_gather",
        metal_backend_file: "mlx/backend/metal/kernels/indexing.metal",
        kernel_family: "gather",
        dispatch_conditions: INDEXING_DISPATCH,
        supported_dtypes: &[
            DtypeFlag::Float16,
            DtypeFlag::BFloat16,
            DtypeFlag::Float32,
            DtypeFlag::Int8,
            DtypeFlag::Int16,
            DtypeFlag::Int32,
            DtypeFlag::Uint8,
            DtypeFlag::Uint32,
            DtypeFlag::Uint64,
        ],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: false,
            reduce_dim: None,
            batch_contiguous: false,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
    // ── Residual add ───────────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "residual_add",
        c_primitive: "mlx_residual_add",
        metal_backend_file: "mlx/backend/metal/kernels/arithmetic.metal",
        kernel_family: "residual_add",
        dispatch_conditions: RESIDUAL_ADD_DISPATCH,
        supported_dtypes: &[DtypeFlag::Float16, DtypeFlag::BFloat16, DtypeFlag::Float32],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: false,
            reduce_dim: None,
            batch_contiguous: false,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
    // ── Broadcast reshape ──────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "broadcast_reshape",
        c_primitive: "mlx_broadcast_reshape",
        metal_backend_file: "mlx/backend/metal/kernels/reshape.metal",
        kernel_family: "broadcast_reshape",
        dispatch_conditions: BROADCAST_RESHAPE_DISPATCH,
        supported_dtypes: &[
            DtypeFlag::Float16,
            DtypeFlag::BFloat16,
            DtypeFlag::Float32,
            DtypeFlag::Int8,
            DtypeFlag::Int16,
            DtypeFlag::Int32,
            DtypeFlag::Uint8,
            DtypeFlag::Uint32,
            DtypeFlag::Uint64,
        ],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: true,
            reduce_dim: None,
            batch_contiguous: true,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
    // ── Concatenate ────────────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "concatenate",
        c_primitive: "mlx_concatenate",
        metal_backend_file: "mlx/backend/metal/kernels/copy.metal",
        kernel_family: "concatenate",
        dispatch_conditions: CONCATENATE_DISPATCH,
        supported_dtypes: &[
            DtypeFlag::Float16,
            DtypeFlag::BFloat16,
            DtypeFlag::Float32,
            DtypeFlag::Int8,
            DtypeFlag::Int16,
            DtypeFlag::Int32,
            DtypeFlag::Uint8,
            DtypeFlag::Uint32,
            DtypeFlag::Uint64,
        ],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: true,
            reduce_dim: None,
            batch_contiguous: true,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
    // ── Dtype cast ─────────────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "dtype_cast",
        c_primitive: "mlx_dtype_cast",
        metal_backend_file: "mlx/backend/metal/kernels/copy.metal",
        kernel_family: "dtype_cast",
        dispatch_conditions: DTYPE_CAST_DISPATCH,
        supported_dtypes: &[
            DtypeFlag::Float16,
            DtypeFlag::BFloat16,
            DtypeFlag::Float32,
            DtypeFlag::Int8,
            DtypeFlag::Int16,
            DtypeFlag::Int32,
            DtypeFlag::Uint8,
            DtypeFlag::Uint32,
            DtypeFlag::Uint64,
        ],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: false,
            reduce_dim: None,
            batch_contiguous: false,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
    // ── Contiguous copy ────────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "contiguous_copy",
        c_primitive: "mlx_contiguous_copy",
        metal_backend_file: "mlx/backend/metal/kernels/copy.metal",
        kernel_family: "contiguous_copy",
        dispatch_conditions: CONTIGUOUS_COPY_DISPATCH,
        supported_dtypes: &[
            DtypeFlag::Float16,
            DtypeFlag::BFloat16,
            DtypeFlag::Float32,
            DtypeFlag::Int8,
            DtypeFlag::Int16,
            DtypeFlag::Int32,
            DtypeFlag::Uint8,
            DtypeFlag::Uint32,
            DtypeFlag::Uint64,
        ],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: false,
            reduce_dim: None,
            batch_contiguous: false,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
    // ── Argmax ─────────────────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "argmax",
        c_primitive: "mlx_argmax",
        metal_backend_file: "mlx/backend/metal/kernels/reduce.metal",
        kernel_family: "argmax",
        dispatch_conditions: ARGMAX_DISPATCH,
        supported_dtypes: &[DtypeFlag::Float16, DtypeFlag::BFloat16, DtypeFlag::Float32],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: false,
            reduce_dim: Some(1),
            batch_contiguous: true,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: true,
        },
        compile_eligible: true,
    },
    // ── Top-k ──────────────────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "topk",
        c_primitive: "mlx_topk",
        metal_backend_file: "mlx/backend/metal/kernels/sort.metal",
        kernel_family: "topk",
        dispatch_conditions: TOPK_DISPATCH,
        supported_dtypes: &[DtypeFlag::Float16, DtypeFlag::BFloat16, DtypeFlag::Float32],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: false,
            reduce_dim: Some(1),
            batch_contiguous: true,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: true,
            per_element: 4.0,
            fixed_min: 4096,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: true,
        },
        compile_eligible: true,
    },
    // ── Cache update ───────────────────────────────────────────────────────
    MlxPrimitive {
        public_op: "cache_update",
        c_primitive: "mlx_cache_update",
        metal_backend_file: "mlx/backend/metal/kernels/kv_cache.metal",
        kernel_family: "cache_update",
        dispatch_conditions: CACHE_UPDATE_DISPATCH,
        supported_dtypes: &[DtypeFlag::Float16, DtypeFlag::BFloat16],
        contiguity_reqs: ContiguityReqs {
            all_contiguous: false,
            reduce_dim: None,
            batch_contiguous: true,
        },
        alignment: Alignment {
            input_align: 4,
            output_align: 4,
            stride_multiple: 1,
        },
        temp_buffer: TempBuffer {
            required: false,
            per_element: 0.0,
            fixed_min: 0,
        },
        sync: Sync {
            gpu_sync_required: true,
            host_fence: false,
        },
        compile_eligible: true,
    },
];

// ── Fork divergences ───────────────────────────────────────────────────────

/// Record of each documented fork divergence from upstream mlx.
const DIVERGENCES: &[ForkDivergence] = &[
    ForkDivergence {
        area: "external_array",
        id: "no_copy_constructor",
        description: "Fork adds mlx_array_new_data_managed_payload to construct arrays from externally owned memory without copying, using a C deleter callback. Upstream mlx 0.31.2 requires copying via mlx_array_new_data or manual memcpy.",
        is_extension: true,
    },
    ForkDivergence {
        area: "quantized_api",
        id: "patched_quantized_matmul",
        description: "Fork patches quantized_matmul to expose split-k variants and qmv/qvm/qmm dispatch. Upstream mlx 0.31.2 exposes only a single quantized_matmul path with no split-k or family tags.",
        is_extension: true,
    },
    ForkDivergence {
        area: "quantized_api",
        id: "metal_kernel_bundling",
        description: "Fork bundles Metal kernel source files (quantized.metal, norm.metal, rope.metal, softmax.metal, activations.metal, indexing.metal) directly in the crate. Upstream mlx loads these from an external Metal library at runtime.",
        is_extension: false,
    },
    ForkDivergence {
        area: "external_array",
        id: "deleter_context_box",
        description: "Fork uses a boxed DeleterContext on the Rust side to manage the lifetime of external allocations, invoking the C deleter once MLX drops the array. Upstream mlx does not expose a Rust-managed deleter path.",
        is_extension: true,
    },
    ForkDivergence {
        area: "metal_custom_kernel",
        id: "row_contiguous_default",
        description: "Fork defaults all custom Metal kernels to row-contiguous dispatch (kernel threads map to output rows) unless an explicit threadgroup layout override is provided. Upstream mlx 0.31.2 uses a general-purpose grid dispatch that may issue non-contiguous threadgroup reads, requiring explicit contiguity checks in the shader.",
        is_extension: true,
    },
];

// ── MlxInventory

/// Top-level inventory of the MLX fork's primitive catalogue and divergences.
///
/// Consumers (compiler, runtime, CI audits) read this to understand
/// which primitives are available, how they dispatch, and what patches
/// distinguish this fork from upstream mlx.
#[derive(Debug, Clone, Serialize)]
pub struct MlxInventory {
    /// Git commit SHA of the forked mlx-c layer.
    pub fork_commit: &'static str,
    /// Upstream mlx version this fork targets.
    pub mlx_version: &'static str,
    /// Every forked primitive.
    pub primitives: &'static [MlxPrimitive],
    /// Every documented fork divergence.
    pub divergences: &'static [ForkDivergence],
}

/// Canonical singleton describing the current fork state.
pub const FORK_INVENTORY: MlxInventory = MlxInventory {
    fork_commit: "mlx-fork-0.31.2-tribunus-1",
    mlx_version: "0.31.2",
    primitives: PRIMITIVES,
    divergences: DIVERGENCES,
};

impl MlxInventory {
    /// Return all primitives whose `public_op` matches `name`.
    pub fn primitives_by_op(&self, name: &str) -> Vec<&MlxPrimitive> {
        self.primitives
            .iter()
            .filter(|p| p.public_op == name)
            .collect()
    }

    /// Return the first primitive matching both `public_op` and `kernel_family`.
    pub fn primitive(&self, op: &str, family: &str) -> Option<&'static MlxPrimitive> {
        self.primitives
            .iter()
            .find(|p| p.public_op == op && p.kernel_family == family)
    }

    /// Return all divergences in a given area.
    pub fn divergences_by_area(&self, area: &str) -> Vec<&ForkDivergence> {
        self.divergences.iter().filter(|d| d.area == area).collect()
    }

    /// Serialise the full inventory for diagnostic output.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_is_populated() {
        assert!(!FORK_INVENTORY.primitives.is_empty());
        assert!(!FORK_INVENTORY.divergences.is_empty());
        assert_eq!(FORK_INVENTORY.mlx_version, "0.31.2");
    }

    #[test]
    fn primitives_by_op_quantized_matmul() {
        let qm = FORK_INVENTORY.primitives_by_op("quantized_matmul");
        assert!(
            qm.len() >= 2,
            "expected qmv + split_k entries, got {}",
            qm.len()
        );
        assert!(qm.iter().any(|p| p.kernel_family == "qmv"));
        assert!(qm.iter().any(|p| p.kernel_family == "split_k"));
    }

    #[test]
    fn primitive_lookup() {
        let rn = FORK_INVENTORY.primitive("rms_norm", "rms_norm");
        assert!(rn.is_some());
        assert_eq!(rn.unwrap().c_primitive, "mlx_rms_norm");
        assert!(rn.unwrap().supported_dtypes.contains(&DtypeFlag::Float32));

        let missing = FORK_INVENTORY.primitive("rms_norm", "unknown");
        assert!(missing.is_none());
    }

    #[test]
    fn divergences_by_area() {
        let ea = FORK_INVENTORY.divergences_by_area("external_array");
        assert!(ea.len() >= 1);
        assert!(ea.iter().any(|d| d.id == "no_copy_constructor"));
    }

    #[test]
    fn dispatch_conditions_non_empty() {
        for p in FORK_INVENTORY.primitives {
            assert!(
                !p.dispatch_conditions.is_empty(),
                "primitive {} has no dispatch conditions",
                p.public_op,
            );
        }
    }

    #[test]
    fn compile_eligible_is_true_for_all_current_primitives() {
        for p in FORK_INVENTORY.primitives {
            assert!(
                p.compile_eligible,
                "primitive {} is not compile eligible",
                p.public_op
            );
        }
    }
}
