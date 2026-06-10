//! E0008-F32-MATMUL-3WAY-v1 experiment artifacts.
//!
//! Every artifact carries a canonical SHA-256 digest computed from its
//! semantic fields.  "Sealed" means the digest is non-empty and verifiable.

use crate::backend::routing::*;
use crate::backend::DType;

// ── Error type ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ExperimentArtifactError(pub String);

impl std::fmt::Display for ExperimentArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<String> for ExperimentArtifactError {
    fn from(s: String) -> Self { Self(s) }
}

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

fn dtype_disc(d: DType) -> u8 {
    match d { DType::F32=>0, DType::F16=>1, DType::BF16=>2, DType::I8=>3, DType::U8=>4, DType::I32=>5, DType::U32=>6 }
}

fn layout_disc(l: &PhysicalLayout) -> u8 {
    match l { PhysicalLayout::RowMajor=>0, PhysicalLayout::ColumnMajor=>1, PhysicalLayout::PackedU32{..}=>2, PhysicalLayout::Custom(_)=>3 }
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

    /// Canonical SHA-256 digest covering EVERY semantic field.
    pub fn digest(&self) -> EvidenceDigest {
        use sha2::{Sha256, Digest};
        let mut buf = Vec::new();
        buf.extend_from_slice(&self.schema_version.to_le_bytes());
        buf.extend_from_slice(&self.operation_id.0.to_le_bytes());
        buf.extend_from_slice(&self.m.to_le_bytes());
        buf.extend_from_slice(&self.n.to_le_bytes());
        buf.extend_from_slice(&self.k.to_le_bytes());
        buf.push(self.transpose_a as u8);
        buf.push(self.transpose_b as u8);
        buf.push(dtype_disc(self.input_a_dtype));
        buf.push(dtype_disc(self.input_b_dtype));
        buf.push(dtype_disc(self.output_dtype));
        buf.push(layout_disc(&self.input_a_layout));
        buf.push(layout_disc(&self.input_b_layout));
        buf.push(layout_disc(&self.output_layout));
        EvidenceDigest(format!("{:x}", Sha256::digest(&buf)))
    }
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
    pub min_val: f64, pub max_val: f64, pub mean: f64, pub stddev: f64,
}

#[derive(Debug, Clone)]
pub struct InputDataset {
    pub dataset_id: String,
    pub experiment_revision: u32,
    pub contract_digest: EvidenceDigest,
    pub tensors: Vec<InputTensor>,
    pub generator_seed: u64,
    pub generator_algorithm: String,
    pub sha256: EvidenceDigest,
}

impl InputDataset {
    /// Generate deterministic input tensors via SHA-256-derived seed.
    /// Golden-vector reproducibility is guaranteed by the frozen seed
    /// derivation algorithm.
    pub fn generate(
        experiment_revision: u32,
        contract: &F32MatmulContract,
    ) -> Result<Self, ExperimentArtifactError> {
        use sha2::{Sha256, Digest};

        // Canonical seed: first 8 bytes of SHA-256("tribunus-e0008-input-v1"
        // || contract_digest || revision LE)
        let mut seed_hasher = Sha256::new();
        seed_hasher.update(b"tribunus-e0008-input-v1");
        seed_hasher.update(contract.digest().0.as_bytes());
        seed_hasher.update(&experiment_revision.to_le_bytes());
        let seed_bytes = seed_hasher.finalize();
        let seed = u64::from_le_bytes(seed_bytes[..8].try_into().unwrap());

        let mut rng = LcgRng::new(seed);

        let a_elems = (contract.m as usize)
            .checked_mul(contract.k as usize)
            .ok_or_else(|| ExperimentArtifactError("A element count overflow".into()))?;
        let b_elems = (contract.k as usize)
            .checked_mul(contract.n as usize)
            .ok_or_else(|| ExperimentArtifactError("B element count overflow".into()))?;

        let a_f32: Vec<f32> = (0..a_elems).map(|_| rng.next_f32_bounded()).collect();
        let b_f32: Vec<f32> = (0..b_elems).map(|_| rng.next_f32_bounded()).collect();

        let a_tensor = make_tensor(TensorId(0), &a_f32, &[contract.m, contract.k], DType::F32, PhysicalLayout::RowMajor);
        let b_tensor = make_tensor(TensorId(1), &b_f32, &[contract.k, contract.n], DType::F32, PhysicalLayout::RowMajor);
        let tensors = vec![a_tensor, b_tensor];

        // Dataset-level digest: canonical manifest + raw tensor digests
        let mut dhash = Sha256::new();
        dhash.update(b"E0008-dataset-v1\n");
        dhash.update(&experiment_revision.to_le_bytes());
        dhash.update(contract.digest().0.as_bytes());
        dhash.update(&seed.to_le_bytes());
        for t in &tensors {
            dhash.update(&t.tensor_id.0.to_le_bytes());
            dhash.update(&(t.shape.len() as u32).to_le_bytes());
            for &d in &t.shape { dhash.update(&d.to_le_bytes()); }
            dhash.update(&[dtype_disc(t.dtype)]);
            dhash.update(t.sha256.0.as_bytes());
        }
        let dataset_digest = EvidenceDigest(format!("{:x}", dhash.finalize()));

        Ok(InputDataset {
            dataset_id: format!("E0008-dataset-{}-rev{}", contract.operation_id.0, experiment_revision),
            experiment_revision,
            contract_digest: contract.digest(),
            tensors,
            generator_seed: seed,
            generator_algorithm: "tribunus-e0008-input-v1".into(),
            sha256: dataset_digest,
        })
    }

    pub fn verify(&self) -> bool {
        // Recompute and compare
        self.sha256.0 == Self::recompute_digest(self)
    }

    fn recompute_digest(ds: &InputDataset) -> String {
        use sha2::{Sha256, Digest};
        let mut h = Sha256::new();
        h.update(b"E0008-dataset-v1\n");
        h.update(&ds.experiment_revision.to_le_bytes());
        h.update(ds.contract_digest.0.as_bytes());
        h.update(&ds.generator_seed.to_le_bytes());
        for t in &ds.tensors {
            h.update(&t.tensor_id.0.to_le_bytes());
            h.update(&(t.shape.len() as u32).to_le_bytes());
            for &d in &t.shape { h.update(&d.to_le_bytes()); }
            h.update(&[dtype_disc(t.dtype)]);
            h.update(t.sha256.0.as_bytes());
        }
        format!("{:x}", h.finalize())
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
    /// Fixture for tests only — not claim-grade.
    pub fn m1_fixture() -> Self {
        Self {
            profile_id: "m1-fixture".into(),
            hardware_model: "Apple Silicon".into(),
            chip: "Apple M1".into(),
            memory_gb: 16,
            os_version: "macOS".into(),
            backend_versions: vec![
                BackendVersionInfo { backend_name: "mlx".into(), version: "-".into(), git_commit: None },
                BackendVersionInfo { backend_name: "accelerate".into(), version: "-".into(), git_commit: None },
                BackendVersionInfo { backend_name: "coreml".into(), version: "-".into(), git_commit: None },
            ],
            rustc_version: "-".into(),
            target_triple: "aarch64-apple-darwin".into(),
            sha256: EvidenceDigest("".into()),
        }
    }

    /// Claim-grade: all fields must be non-empty. Returns Err if any
    /// field is a placeholder.
    pub fn validate_claim_grade(&self) -> Result<(), ExperimentArtifactError> {
        if self.sha256.0.is_empty() { return Err(ExperimentArtifactError("MachineProfile.sha256 is empty".into())); }
        if self.rustc_version == "-" || self.rustc_version == "unknown" { return Err(ExperimentArtifactError("rustc_version is a placeholder".into())); }
        for bv in &self.backend_versions {
            if bv.version == "-" { return Err(ExperimentArtifactError(format!("{} version is a placeholder", bv.backend_name))); }
        }
        Ok(())
    }

    pub fn seal(&mut self) -> EvidenceDigest {
        use sha2::{Sha256, Digest};
        let mut h = Sha256::new();
        h.update(self.profile_id.as_bytes());
        h.update(self.hardware_model.as_bytes());
        h.update(self.chip.as_bytes());
        h.update(&self.memory_gb.to_le_bytes());
        h.update(self.os_version.as_bytes());
        for bv in &self.backend_versions {
            h.update(bv.backend_name.as_bytes());
            h.update(bv.version.as_bytes());
        }
        h.update(self.rustc_version.as_bytes());
        h.update(self.target_triple.as_bytes());
        let digest = EvidenceDigest(format!("{:x}", h.finalize()));
        self.sha256 = digest.clone();
        digest
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
        let mut p = Self {
            profile_name: "F32-MATMUL-MLX-GPU-v1".into(),
            backend: BackendId(0),
            requested_substrate: RequestedSubstrate::Gpu,
            contract_digest: contract.digest(),
            sha256: EvidenceDigest("".into()),
        };
        p.seal();
        p
    }

    pub fn accelerate_cpu(contract: &F32MatmulContract) -> Self {
        let mut p = Self {
            profile_name: "F32-MATMUL-ACCELERATE-CPU-v1".into(),
            backend: BackendId(1),
            requested_substrate: RequestedSubstrate::Cpu,
            contract_digest: contract.digest(),
            sha256: EvidenceDigest("".into()),
        };
        p.seal();
        p
    }

    pub fn coreml_ane(contract: &F32MatmulContract) -> Self {
        let mut p = Self {
            profile_name: "F32-MATMUL-COREML-CPU-ANE-v1".into(),
            backend: BackendId(2),
            requested_substrate: RequestedSubstrate::CpuAndNeuralEngine,
            contract_digest: contract.digest(),
            sha256: EvidenceDigest("".into()),
        };
        p.seal();
        p
    }

    pub fn seal(&mut self) {
        use sha2::{Sha256, Digest};
        let mut h = Sha256::new();
        h.update(self.profile_name.as_bytes());
        h.update(&self.backend.0.to_le_bytes());
        h.update(&[requested_substrate_disc(&self.requested_substrate)]);
        h.update(self.contract_digest.0.as_bytes());
        self.sha256 = EvidenceDigest(format!("{:x}", h.finalize()));
    }

    pub fn verify(&self) -> bool {
        use sha2::{Sha256, Digest};
        let mut h = Sha256::new();
        h.update(self.profile_name.as_bytes());
        h.update(&self.backend.0.to_le_bytes());
        h.update(&[requested_substrate_disc(&self.requested_substrate)]);
        h.update(self.contract_digest.0.as_bytes());
        self.sha256.0 == format!("{:x}", h.finalize())
    }
}

fn requested_substrate_disc(s: &RequestedSubstrate) -> u8 {
    match s { RequestedSubstrate::Cpu=>0, RequestedSubstrate::Gpu=>1, RequestedSubstrate::NeuralEngine=>2, RequestedSubstrate::CpuAndGpu=>3, RequestedSubstrate::CpuAndNeuralEngine=>4, RequestedSubstrate::All=>5 }
}

// ── Experiment manifest ───────────────────────────────────────────────

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

        // Three profiles per contract (12 total for 4 contracts)
        let mut profiles = Vec::new();
        for c in &contracts {
            profiles.push(SealedExperimentProfile::mlx_control(c));
            profiles.push(SealedExperimentProfile::accelerate_cpu(c));
            profiles.push(SealedExperimentProfile::coreml_ane(c));
        }

        Self {
            experiment_id: "E0008-F32-MATMUL-3WAY-v1".into(),
            experiment_revision,
            source_commit: String::new(),
            cargo_profile: "inference-evidence".into(),
            rustc_version: String::new(),
            target_triple: "aarch64-apple-darwin".into(),
            contracts,
            profiles,
            tolerance: F32MatmulTolerance::default(),
            machine: MachineProfile::m1_fixture(),
            dataset: None,
            sha256: EvidenceDigest("".into()),
        }
    }

    pub fn seal(&mut self) -> EvidenceDigest {
        use sha2::{Sha256, Digest};
        let mut h = Sha256::new();
        h.update(b"E0008-manifest-v1\n");
        h.update(self.experiment_id.as_bytes());
        h.update(&self.experiment_revision.to_le_bytes());
        for c in &self.contracts {
            h.update(c.digest().0.as_bytes());
        }
        for p in &self.profiles {
            h.update(p.sha256.0.as_bytes());
        }
        h.update(self.tolerance.digest().0.as_bytes());
        h.update(self.machine.sha256.0.as_bytes());
        if let Some(ref ds) = self.dataset {
            h.update(ds.sha256.0.as_bytes());
        }
        let digest = EvidenceDigest(format!("{:x}", h.finalize()));
        self.sha256 = digest.clone();
        digest
    }

    pub fn verify(&self) -> bool {
        if self.sha256.0.is_empty() { return false; }
        let mut expected = self.clone();
        expected.seal();
        self.sha256 == expected.sha256
    }
}

// ── Tolerance ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct F32MatmulTolerance {
    pub schema_version: u32,
    pub atol: f64,
    pub rtol: f64,
    pub near_zero_threshold: f64,
    pub min_cosine: f64,
    pub max_relative_error: f64,
}

impl Default for F32MatmulTolerance {
    fn default() -> Self {
        Self { schema_version: 1, atol: 1e-3, rtol: 1e-3, near_zero_threshold: 1e-6, min_cosine: 0.999999, max_relative_error: 5e-4 }
    }
}

impl F32MatmulTolerance {
    pub fn digest(&self) -> EvidenceDigest {
        use sha2::{Sha256, Digest};
        let mut buf = Vec::new();
        buf.extend_from_slice(&self.schema_version.to_le_bytes());
        buf.extend_from_slice(&self.atol.to_le_bytes());
        buf.extend_from_slice(&self.rtol.to_le_bytes());
        buf.extend_from_slice(&self.near_zero_threshold.to_le_bytes());
        buf.extend_from_slice(&self.min_cosine.to_le_bytes());
        buf.extend_from_slice(&self.max_relative_error.to_le_bytes());
        EvidenceDigest(format!("{:x}", Sha256::digest(&buf)))
    }
}

// ── Correctness result ──────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CorrectnessResult {
    pub output_sha256: String, pub element_count: usize,
    pub finite_count: usize, pub nan_count: usize, pub inf_count: usize,
    pub max_abs_error: f64, pub mean_abs_error: f64, pub max_rel_error: f64,
    pub cosine_similarity: f64, pub passed: bool,
}

// ── LCG RNG ──────────────────────────────────────────────────────────

struct LcgRng { state: u64 }

impl LcgRng {
    fn new(seed: u64) -> Self { Self { state: seed.wrapping_add(1) } }
    fn next(&mut self) -> u64 {
        self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.state
    }
    fn next_f32_bounded(&mut self) -> f32 {
        let u = (self.next() as f64) / (u64::MAX as f64);
        (u as f32 - 0.5) * 0.25
    }
}

// ── Helper ───────────────────────────────────────────────────────────

fn make_tensor(id: TensorId, data: &[f32], shape: &[u32], dtype: DType, layout: PhysicalLayout) -> InputTensor {
    use sha2::{Sha256, Digest};
    let bytes: Vec<u8> = data.iter().flat_map(|f| f.to_le_bytes()).collect();
    let hash = EvidenceDigest(format!("{:x}", Sha256::digest(&bytes)));
    let min_val = data.iter().fold(f64::INFINITY, |a, &b| a.min(b as f64));
    let max_val = data.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b as f64));
    let mean = data.iter().map(|&f| f as f64).sum::<f64>() / data.len() as f64;
    let variance = data.iter().map(|&f| { let d = f as f64 - mean; d*d }).sum::<f64>() / data.len() as f64;
    InputTensor { tensor_id: id, shape: shape.to_vec(), dtype, layout, data: bytes, sha256: hash, element_count: data.len() as u64, byte_count: (data.len()*4) as u64, min_val, max_val, mean, stddev: variance.sqrt() }
}
