//! Execution placement profiles — the schema for placement-aware dispatch.
//!
//! Describes where and how a compute graph should be executed across
//! available backends (MLX GPU, MLX CPU, Accelerate, Core ML ANE, Rust
//! NEON, control-plane CPU, or fusion-only paths). Independent from
//! the hybrid deployment profile and the canonical model representation.

use serde::{Deserialize, Serialize};

/// Classification of an execution candidate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CandidateClass {
    /// MLX GPU is preferred but a fallback candidate is acceptable.
    /// Replaces the former `MlxGpuRequired` — nothing is strictly required
    /// at the profile level; the compiler promotes to mandatory when fusion
    /// graphs force it.
    MlxGpuPreferred,
    /// MLX CPU path is preferred (e.g. for small batch sizes).
    MlxCpuPreferred,
    /// Accelerate.framework (vDSP/vImage) preferred.
    AcceleratePreferred,
    /// Core ML ANE candidate (Apple Neural Engine via Core ML).
    /// Renamed from `CoreMlAnePreferred` — this is an experimental candidate
    /// path that benchmarks must validate before dispatch.
    CoreMlAneCandidate,
    /// Any available backend — no specific preference.
    AllPreferred,
    /// Rust NEON SIMD path preferred (CPU-side inference).
    RustNeonPreferred,
    /// Reserved for control-plane CPU dispatch (orchestration, not compute).
    ControlPlaneCpu,
    /// Fusion-only path — no standalone ops, all fused into surrounding kernels.
    FusionOnly,
    /// Benchmark has not resolved a candidate yet.
    BenchmarkUnresolved,
}

/// A placement region: one candidate backend with a relative weight.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaceRegion {
    /// Unique identifier within the profile.
    pub id: String,
    /// The candidate class this region represents.
    pub candidate: CandidateClass,
    /// Relative weight for ordering (higher = preferred sooner).
    pub weight: u32,
    /// Optional descriptive label (e.g. "default", "backup", "experimental").
    pub label: Option<String>,
}

/// Execution placement profile — maps a compiled image to candidate backends.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPlacementProfile {
    /// Hash of the ComputeImage artifact this profile governs.
    pub image_hash: String,
    /// MLX version string this profile targets (e.g. "0.28.0").
    pub mlx_version: String,
    /// Ordered placement regions (descending preference).
    pub regions: Vec<PlaceRegion>,
}

impl ExecutionPlacementProfile {
    /// Validate internal consistency.
    ///
    /// Checks:
    /// - At least one region is present.
    /// - Region IDs are unique.
    /// - No contradictory constraints (e.g. two required classes of different kinds
    ///   is allowed — the caller resolves interpretively).
    pub fn validate(&self) -> Result<(), String> {
        if self.regions.is_empty() {
            return Err("placement profile must have at least one region".into());
        }

        let mut seen = std::collections::HashSet::new();
        for region in &self.regions {
            if !seen.insert(&region.id) {
                return Err(format!("duplicate region id: {}", region.id));
            }
        }

        Ok(())
    }
}

/// A deployment profile for compute resource placement decisions.
///
/// Captures the resource dimension, workload class, and deployment topology
/// needed to select a suitable compute target. Independent from the execution
/// placement profile (which governs per-operation candidate backends) — this
/// profile governs where and at what resource level a full workload deploys.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentProfile {
    /// Unique profile identifier (e.g. "m1-latency-v1").
    pub profile_id: String,
    /// Workload classification — one of "latency", "throughput", "constrained",
    /// or "fallback". Drives scheduling and resource reservation.
    pub workload_class: String,
    /// Scheduling priority (higher = more urgent). Used for preemption ordering.
    pub priority: u32,
    /// Target deployment regions (e.g. "us-west-1", "eu-west-1").
    pub regions: Vec<String>,
    /// Chip family target (e.g. "m1", "m2", "m3", "m4", "m5").
    pub chip_family: String,
    /// Memory capacity in GB.
    pub memory_capacity_gb: u32,
    /// Maximum concurrent sessions this profile supports.
    pub max_sessions: u32,
}

// ---------------------------------------------------------------------------
// M1 deployment profile generators
// ---------------------------------------------------------------------------

/// Generate an M1 latency-optimized deployment profile.
///
/// Latency profiles minimise request-level tail latency at the expense of
/// throughput. They use low concurrency, moderate memory, and highest
/// scheduling priority to preempt batch workloads.
pub fn generate_m1_latency_profile() -> DeploymentProfile {
    DeploymentProfile {
        profile_id: "m1-latency-v1".into(),
        workload_class: "latency".into(),
        priority: 100,
        regions: vec!["us-west-1".into(), "us-east-1".into()],
        chip_family: "m1".into(),
        memory_capacity_gb: 8,
        max_sessions: 4,
    }
}

/// Generate an M1 throughput-optimized deployment profile.
///
/// Throughput profiles maximise batch size and session count. They trade
/// single-request latency for higher aggregate throughput across concurrent
/// sessions.
pub fn generate_m1_throughput_profile() -> DeploymentProfile {
    DeploymentProfile {
        profile_id: "m1-throughput-v1".into(),
        workload_class: "throughput".into(),
        priority: 50,
        regions: vec![
            "us-west-1".into(),
            "us-east-1".into(),
            "eu-west-1".into(),
        ],
        chip_family: "m1".into(),
        memory_capacity_gb: 16,
        max_sessions: 16,
    }
}

/// Generate an M1 memory-constrained deployment profile.
///
/// Constrained profiles run in resource-limited environments (e.g. shared
/// clusters or edge deployments). They cap memory and session count tightly
/// and deploy to a single region.
pub fn generate_m1_constrained_profile() -> DeploymentProfile {
    DeploymentProfile {
        profile_id: "m1-constrained-v1".into(),
        workload_class: "constrained".into(),
        priority: 75,
        regions: vec!["us-west-1".into()],
        chip_family: "m1".into(),
        memory_capacity_gb: 4,
        max_sessions: 2,
    }
}

/// Generate a conservative M1 fallback deployment profile.
///
/// Fallback profiles are last-resort candidates when no specialised profile
/// matches. They carry the lowest priority, minimal concurrency, and deploy
/// in a single region.
pub fn generate_m1_fallback_profile() -> DeploymentProfile {
    DeploymentProfile {
        profile_id: "m1-fallback-v1".into(),
        workload_class: "fallback".into(),
        priority: 10,
        regions: vec!["us-west-1".into()],
        chip_family: "m1".into(),
        memory_capacity_gb: 8,
        max_sessions: 1,
    }
}

/// Select the best matching deployment profile from a set of candidates.
///
/// Selection phases (in priority order):
/// 1. Exact match on `workload_class` + `chip_family` — the ideal candidate.
/// 2. Match on `workload_class` alone (any chip family) — relaxed scope.
/// 3. Fallback profile for the same `chip_family` — safe default.
/// 4. Any available fallback profile — desperate last resort.
///
/// Returns `None` only when `profiles` is empty or contains only
/// non-fallback profiles that do not match the requested class or family.
pub fn select_profile<'a>(
    workload_class: &str,
    chip_family: &str,
    profiles: &'a [DeploymentProfile],
) -> Option<&'a DeploymentProfile> {
    // Phase 1: exact workload_class + chip_family match.
    if let Some(p) = profiles
        .iter()
        .find(|p| p.workload_class == workload_class && p.chip_family == chip_family)
    {
        return Some(p);
    }

    // Phase 2: workload_class match with any chip_family.
    if let Some(p) = profiles
        .iter()
        .find(|p| p.workload_class == workload_class)
    {
        return Some(p);
    }

    // Phase 3: fallback profile for the chip_family.
    if let Some(p) = profiles
        .iter()
        .find(|p| p.workload_class == "fallback" && p.chip_family == chip_family)
    {
        return Some(p);
    }

    // Phase 4: any fallback profile.
    profiles
        .iter()
        .find(|p| p.workload_class == "fallback")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_profile() -> ExecutionPlacementProfile {
        ExecutionPlacementProfile {
            image_hash: "sha256:abc123".into(),
            mlx_version: "0.28.0".into(),
            regions: vec![
                PlaceRegion {
                    id: "primary".into(),
                    candidate: CandidateClass::MlxGpuPreferred,
                    weight: 100,
                    label: Some("default".into()),
                },
                PlaceRegion {
                    id: "fallback".into(),
                    candidate: CandidateClass::MlxCpuPreferred,
                    weight: 50,
                    label: Some("fallback".into()),
                },
                PlaceRegion {
                    id: "ane-candidate".into(),
                    candidate: CandidateClass::CoreMlAneCandidate,
                    weight: 80,
                    label: None,
                },
            ],
        }
    }

    #[test]
    fn test_serde_roundtrip() {
        let profile = sample_profile();
        let json = serde_json::to_string(&profile).expect("serialize");
        let parsed: ExecutionPlacementProfile =
            serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.image_hash, "sha256:abc123");
        assert_eq!(parsed.mlx_version, "0.28.0");
        assert_eq!(parsed.regions.len(), 3);
    }

    #[test]
    fn test_validate_ok() {
        let profile = sample_profile();
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn test_validate_empty_regions() {
        let profile = ExecutionPlacementProfile {
            regions: vec![],
            ..sample_profile()
        };
        assert!(profile.validate().is_err());
    }

    #[test]
    fn test_validate_duplicate_id() {
        let profile = ExecutionPlacementProfile {
            regions: vec![
                PlaceRegion {
                    id: "dup".into(),
                    candidate: CandidateClass::MlxGpuPreferred,
                    weight: 100,
                    label: None,
                },
                PlaceRegion {
                    id: "dup".into(),
                    candidate: CandidateClass::MlxCpuPreferred,
                    weight: 50,
                    label: None,
                },
            ],
            ..sample_profile()
        };
        assert!(profile.validate().is_err());
    }

    #[test]
    fn test_candidate_class_serde() {
        let cases = vec![
            (CandidateClass::MlxGpuPreferred, "\"mlxGpuPreferred\""),
            (CandidateClass::MlxCpuPreferred, "\"mlxCpuPreferred\""),
            (CandidateClass::AcceleratePreferred, "\"acceleratePreferred\""),
            (CandidateClass::CoreMlAneCandidate, "\"coreMlAneCandidate\""),
            (CandidateClass::AllPreferred, "\"allPreferred\""),
            (CandidateClass::RustNeonPreferred, "\"rustNeonPreferred\""),
            (CandidateClass::ControlPlaneCpu, "\"controlPlaneCpu\""),
            (CandidateClass::FusionOnly, "\"fusionOnly\""),
            (CandidateClass::BenchmarkUnresolved, "\"benchmarkUnresolved\""),
        ];
        for (variant, expected) in cases {
            let json = serde_json::to_string(&variant).expect("serialize");
            assert_eq!(json, expected, "mismatch for {:?}", variant);
        }
    }
}
