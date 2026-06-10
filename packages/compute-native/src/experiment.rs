//! E0008-F32-MATMUL-3WAY-v1 experiment artifacts.
//!
//! Canonical operation contracts, deterministic input datasets, tolerance
//! policy, sealed placement profiles, machine profile, and experiment
//! manifest.  Every artifact is content-addressed with SHA-256.

use crate::backend::routing::*;
use crate::backend::DType;

// ── F32 matmul contract ───────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct F32MatmulContract {
    pub operation_id: OperationId,
    pub schema_version: u32,
    pub m: u32, pub n: u32, pub k: u32,
    pub transpose_a: bool, pub transpose_b: bool,
    pub input_a_dtype: DType, pub input_b_dtype: DType, pub output_dtype: DType,
    pub input_a_layout: PhysicalLayout,
    pub input_b_layout: PhysicalLayout,
    pub output_layout: PhysicalLayout,
}

impl F32MatmulContract {
    pub fn new(operation_id: OperationId, m: u32, n: u32, k: u32) -> Self {
        Self {
            operation_id, schema_version: 1, m, n, k,
            transpose_a: false, transpose_b: false,
            input_a_dtype: DType::F32, input_b_dtype: DType::F32, output_dtype: DType::F32,
            input_a_layout: PhysicalLayout::RowMajor,
            input_b_layout: PhysicalLayout::RowMajor,
            output_layout: PhysicalLayout::RowMajor,
        }
    }

    pub fn digest(&self) -> EvidenceDigest {
        use sha2::{Sha256, Digest};
        let mut buf = Vec::new();
        buf.push(self.schema_version as u8);
        buf.extend_from_slice(&self.m.to_le_bytes());
        buf.extend_from_slice(&self.n.to_le_bytes());
        buf.extend_from_slice(&self.k.to_le_bytes());
        buf.push(self.transpose_a as u8);
        buf.push(self.transpose_b as u8);
        buf.push(0u8); // dtype F32
        buf.push(0u8); // layout RowMajor
        EvidenceDigest(format!("{:x}", Sha256::digest(&buf)))
    }

    pub fn operation_id_val(&self) -> u64 { self.operation_id.0 }
}

// ── Shape matrices ───────────────────────────────────────────────────

pub fn conformance_shapes() -> Vec<(u32, u32, u32)> {
    vec![(2,3,4), (4,4,4), (3,5,2), (1,7,9)]
}

pub fn representative_shapes() -> Vec<(u32, u32, u32)> {
    let mut shapes = Vec::new();
    for &(k, n) in &[(3840u32, 4096u32)] {
        for &m in &[1u32, 4u32, 16u32] {
            shapes.push((m, k, n));
        }
    }
    shapes
}

// ── Deterministic input dataset ──────────────────────────────────────

#[derive(Debug, Clone)]
pub struct InputTensor {
    pub tensor_id: TensorId,
    pub shape: Vec<u32>,
    pub dtype: DType,
    pub layout: PhysicalLayout,
    pub data: Vec<u8>,
    pub sha256: EvidenceDigest,
    pub element_count: u64,
    pub byte_count: u64,
    pub min_val: f64,
    pub max_val: f64,
    pub mean: f64,
    pub stddev: f64,
}

#[derive(Debug, Clone)]
pub struct InputDataset {
    pub dataset_id: String,
    pub experiment_revision: u32,
    pub contract_digest: EvidenceDigest,
    pub tensors: Vec<InputTensor>,
    pub generator_seed: u64,
    pub sha256: EvidenceDigest,
}

impl InputDataset {
    /// Generate deterministic input tensors for a matmul contract.
    /// Uses a bounded uniform distribution [-0.125, +0.125] seeded
    /// from the contract digest and experiment revision.
    pub fn generate(
        experiment_revision: u32,
        contract: &F32MatmulContract,
    ) -> Self {
        use sha2::{Sha256, Digest};
        use std::hash::{Hash, Hasher};

        // Deterministic seed from contract digest + revision
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        contract.digest().0.hash(&mut hasher);
        experiment_revision.hash(&mut hasher);
        let seed = hasher.finish();

        let mut rng = LcgRng::new(seed);

        // Generate A: M × K
        let a_elems = (contract.m as usize) * (contract.k as usize);
        let a_f32: Vec<f32> = (0..a_elems)
            .map(|_| rng.next_f32_bounded())
            .collect();

        // Generate B: K × N
        let b_elems = (contract.k as usize) * (contract.n as usize);
        let b_f32: Vec<f32> = (0..b_elems)
            .map(|_| rng.next_f32_bounded())
            .collect();

        let a_tensor = make_tensor(
            TensorId(0),
            &a_f32,
            &[contract.m, contract.k],
            DType::F32,
            PhysicalLayout::RowMajor,
        );
        let b_tensor = make_tensor(
            TensorId(1),
            &b_f32,
            &[contract.k, contract.n],
            DType::F32,
            PhysicalLayout::RowMajor,
        );

        let tensors = vec![a_tensor, b_tensor];

        // Dataset-level digest
        let mut dhash = Sha256::new();
        for t in &tensors {
            dhash.update(&t.sha256.0);
        }
        let dataset_digest = EvidenceDigest(format!("{:x}", dhash.finalize()));

        InputDataset {
            dataset_id: format!("E0008-dataset-rev{}", experiment_revision),
            experiment_revision,
            contract_digest: contract.digest(),
            tensors,
            generator_seed: seed,
            sha256: dataset_digest,
        }
    }
}

// ── Machine profile ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MachineProfile {
    pub profile_id: String,
    pub hardware_model: String,
    pub chip: String,
    pub memory_gb: u32,
    pub os_version: String,
    pub backend_versions: Vec<BackendVersionInfo>,
    pub rustc_version: String,
    pub target_triple: String,
    pub sha256: EvidenceDigest,
}

#[derive(Debug, Clone)]
pub struct BackendVersionInfo {
    pub backend_name: String,
    pub version: String,
    pub git_commit: Option<String>,
}

impl MachineProfile {
    pub fn m1_default() -> Self {
        Self {
            profile_id: "m1-macOS-sonoma-v1".into(),
            hardware_model: "MacBookPro18,3".into(),
            chip: "Apple M1".into(),
            memory_gb: 16,
            os_version: "15.0".into(),
            backend_versions: vec![
                BackendVersionInfo {
                    backend_name: "mlx".into(),
                    version: "fork".into(),
                    git_commit: None,
                },
                BackendVersionInfo {
                    backend_name: "accelerate".into(),
                    version: "system".into(),
                    git_commit: None,
                },
                BackendVersionInfo {
                    backend_name: "coreml".into(),
                    version: "system".into(),
                    git_commit: None,
                },
            ],
            rustc_version: env!("CARGO_PKG_VERSION", "unknown").into(),
            target_triple: "aarch64-apple-darwin".into(),
            sha256: EvidenceDigest("".into()),
        }
    }
}

// ── Sealed placement profiles ────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SealedExperimentProfile {
    pub profile_name: String,
    pub backend: BackendId,
    pub requested_substrate: RequestedSubstrate,
    pub contract_digest: EvidenceDigest,
    pub sha256: EvidenceDigest,
}

impl SealedExperimentProfile {
    pub fn mlx_control(contract: &F32MatmulContract) -> Self {
        Self {
            profile_name: "F32-MATMUL-MLX-GPU-v1".into(),
            backend: BackendId(0),
            requested_substrate: RequestedSubstrate::Gpu,
            contract_digest: contract.digest(),
            sha256: EvidenceDigest("".into()),
        }
    }

    pub fn accelerate_cpu(contract: &F32MatmulContract) -> Self {
        Self {
            profile_name: "F32-MATMUL-ACCELERATE-CPU-v1".into(),
            backend: BackendId(1),
            requested_substrate: RequestedSubstrate::Cpu,
            contract_digest: contract.digest(),
            sha256: EvidenceDigest("".into()),
        }
    }

    pub fn coreml_ane(contract: &F32MatmulContract) -> Self {
        Self {
            profile_name: "F32-MATMUL-COREML-CPU-ANE-v1".into(),
            backend: BackendId(2),
            requested_substrate: RequestedSubstrate::CpuAndNeuralEngine,
            contract_digest: contract.digest(),
            sha256: EvidenceDigest("".into()),
        }
    }
}

// ── Experiment manifest ──────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ExperimentManifest {
    pub experiment_id: String,
    pub experiment_revision: u32,
    pub source_commit: String,
    pub cargo_profile: String,
    pub rustc_version: String,
    pub target_triple: String,
    pub contracts: Vec<F32MatmulContract>,
    pub profiles: Vec<SealedExperimentProfile>,
    pub tolerance: F32MatmulTolerance,
    pub machine: MachineProfile,
    pub dataset: Option<InputDataset>,
    pub sha256: EvidenceDigest,
}

impl ExperimentManifest {
    pub fn new(experiment_revision: u32) -> Self {
        let shapes = conformance_shapes();
        let contracts: Vec<F32MatmulContract> = shapes
            .iter()
            .enumerate()
            .map(|(i, &(m, k, n))| F32MatmulContract::new(OperationId(i as u64), m, n, k))
            .collect();

        let profiles = if let Some(first) = contracts.first() {
            vec![
                SealedExperimentProfile::mlx_control(first),
                SealedExperimentProfile::accelerate_cpu(first),
                SealedExperimentProfile::coreml_ane(first),
            ]
        } else {
            vec![]
        };

        Self {
            experiment_id: "E0008-F32-MATMUL-3WAY-v1".into(),
            experiment_revision,
            source_commit: "HEAD".into(),
            cargo_profile: "inference-evidence".into(),
            rustc_version: "unknown".into(),
            target_triple: "aarch64-apple-darwin".into(),
            contracts,
            profiles,
            tolerance: F32MatmulTolerance::default(),
            machine: MachineProfile::m1_default(),
            dataset: None,
            sha256: EvidenceDigest("".into()),
        }
    }
}

// ── Tolerance ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct F32MatmulTolerance {
    pub atol: f64, pub rtol: f64, pub near_zero_threshold: f64,
    pub min_cosine: f64, pub min_relative_error: f64,
}

impl Default for F32MatmulTolerance {
    fn default() -> Self {
        Self { atol: 1e-3, rtol: 1e-3, near_zero_threshold: 1e-6, min_cosine: 0.999999, min_relative_error: 5e-4 }
    }
}

// ── Correctness result ───────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CorrectnessResult {
    pub output_sha256: String, pub element_count: usize,
    pub finite_count: usize, pub nan_count: usize, pub inf_count: usize,
    pub max_abs_error: f64, pub mean_abs_error: f64, pub max_rel_error: f64,
    pub cosine_similarity: f64, pub passed: bool,
}

// ── LCG RNG for deterministic input generation ───────────────────────

struct LcgRng {
    state: u64,
}

impl LcgRng {
    fn new(seed: u64) -> Self {
        Self { state: seed.wrapping_add(1) }
    }

    fn next(&mut self) -> u64 {
        self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.state
    }

    /// Uniform f32 in [-0.125, +0.125]
    fn next_f32_bounded(&mut self) -> f32 {
        let v = self.next();
        let u = (v as f64) / (u64::MAX as f64);
        (u as f32 - 0.5) * 0.25
    }
}

// ── Helper ───────────────────────────────────────────────────────────

fn make_tensor(
    id: TensorId,
    data: &[f32],
    shape: &[u32],
    dtype: DType,
    layout: PhysicalLayout,
) -> InputTensor {
    use sha2::{Sha256, Digest};
    let bytes: Vec<u8> = data.iter().flat_map(|f| f.to_le_bytes()).collect();
    let hash = EvidenceDigest(format!("{:x}", Sha256::digest(&bytes)));

    let min_val = data.iter().fold(f64::INFINITY, |a, &b| a.min(b as f64));
    let max_val = data.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b as f64));
    let mean = data.iter().map(|&f| f as f64).sum::<f64>() / data.len() as f64;
    let variance = data.iter().map(|&f| {
        let d = f as f64 - mean;
        d * d
    }).sum::<f64>() / data.len() as f64;

    InputTensor {
        tensor_id: id,
        shape: shape.to_vec(),
        dtype,
        layout,
        data: bytes,
        sha256: hash,
        element_count: data.len() as u64,
        byte_count: (data.len() * 4) as u64,
        min_val,
        max_val,
        mean,
        stddev: variance.sqrt(),
    }
}
