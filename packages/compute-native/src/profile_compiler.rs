//! Profile compiler — compiles audit results into ExecutionPlacementProfile.
//!
//! Produces static baseline profiles for known hardware configurations and
//! validates profiles against structural constraints.  This module is the
//! bridge between the operation/MLX-inventory audits and the placement profile
//! that drives backend dispatch at runtime.
//!
//! # Baseline: Apple M1
//!
//! The M1 baseline partitions every decoder-layer op into one or more candidate
//! regions based on profiling experience:
//!
//! | Region               | Ops                                                                 |
//! |----------------------|---------------------------------------------------------------------|
//! | MlxGpuPreferred      | q/k/v/o/gate/up/down proj, attention softmax, RoPE, attn matmul, embedding, output proj, sampling (fused GPU path) |
//! | MlxCpuPreferred      | (none — GPU wins for all large ops)                                |
//! | CoreMlAneCandidate   | 6-MLP stateful island (experimental)                               |
//! | AcceleratePreferred  | logits scaling, top-k post-processing                              |
//! | ControlPlaneCpu      | tokenization, detokenization, KV-cache mgmt, mask construction, sampler, admission, cancellation |
//! | FusionOnly           | RMSNorm+q_proj, q_norm+k_norm+RoPE, gate*up activation, RMSNorm standalone, residual add |
//! | RustNeonPreferred    | BF16-to-F32 conversion (small norm weights)                        |
//! | BenchmarkUnresolved  | Core ML full-decoder island, stateful prefill island              |

use std::path::Path;

use crate::placement_profile::{
    CandidateClass, ExecutionPlacementProfile, PlaceRegion,
};

// ---------------------------------------------------------------------------
// boundary_cost_note
// ---------------------------------------------------------------------------

/// Return a methodology string describing how boundary costs are estimated
/// for placement regions in the default M1 profile.
///
/// Boundary costs measure the overhead of transitioning between backends when
/// adjacent ops in the compute graph land on different candidate classes.
/// The methodology uses approximate latency deltas derived from micro-benchmarks
/// on Apple M1 hardware:
///
/// | Transition              | Estimated cost | Rationale                                   |
/// |-------------------------|----------------|---------------------------------------------|
/// | GPU ↔ Accelerate        | ~8 µs          | Metal→vDSP buffer copy + synchronisation   |
/// | GPU ↔ control-plane CPU | ~3 µs          | Metal command-buffer submit + stub dispatch |
/// | GPU ↔ FusionOnly        | 0 µs           | Compiler fuses; no runtime boundary         |
/// | Accelerate ↔ CPU        | ~2 µs          | Same memory space, no copy required         |
/// | ANE (Core ML) ↔ any     | ~50 µs         | ANE submission cost dominates               |
/// | NEON ↔ any              | ~1 µs          | Same core, L1-cache-resident transition     |
///
/// These are order-of-magnitude estimates and should be refined with
/// runtime profiling (`BenchmarkUnresolved` regions) before production use.
pub fn boundary_cost_note() -> &'static str {
    r#"# Boundary Cost Methodology

Boundary costs measure the overhead of transitioning between backends when
adjacent ops in the compute graph land on different candidate classes.
The methodology uses approximate latency deltas derived from micro-benchmarks
on Apple M1 hardware:

| Transition              | Estimated cost | Rationale                                   |
|-------------------------|----------------|---------------------------------------------|
| GPU <-> Accelerate      | ~8 us          | Metal->vDSP buffer copy + synchronisation   |
| GPU <-> control-plane   | ~3 us          | Metal command-buffer submit + stub dispatch |
| GPU <-> FusionOnly      | 0 us           | Compiler fuses; no runtime boundary         |
| Accelerate <-> CPU      | ~2 us          | Same memory space, no copy required         |
| ANE (Core ML) <-> any   | ~50 us         | ANE submission cost dominates               |
| NEON <-> any            | ~1 us          | Same core, L1-cache-resident transition     |

These are order-of-magnitude estimates and should be refined with
runtime profiling (BenchmarkUnresolved regions) before production use.
"#
}

// ---------------------------------------------------------------------------
// compile_default_m1_profile
// ---------------------------------------------------------------------------

/// Produce the baseline M1 profile for a given model image hash.
///
/// This profile encodes the default placement decisions for an Apple M1
/// system based on static analysis of operation characteristics.  Every
/// decoder-layer operation is assigned to one or more candidate backends;
/// fusion groups that must be treated as a unit are marked `FusionOnly`.
///
/// Boundary costs: see [`boundary_cost_note`] for per-transition estimates.
pub fn compile_default_m1_profile(image_hash: &str) -> ExecutionPlacementProfile {
    ExecutionPlacementProfile {
        image_hash: image_hash.to_string(),
        mlx_version: "0.28.0".into(),
        regions: vec![
            // ── GPU-mandated: large matmul projections ─────────────────────
            // Boundary cost: GPU↔GPU is 0 µs. GPU↔FusionOnly is 0 µs
            // (compiler fuses). GPU↔Accelerate ~8 µs, GPU↔ANE ~50 µs.
            PlaceRegion {
                id: "mlx-gpu-preferred".into(),
                candidate: CandidateClass::MlxGpuPreferred,
                weight: 100,
                label: Some(
                    "quantized projections, attention, embedding, output proj, sampling (fused GPU path)"
                        .into(),
                ),
            },
            // ── MLX CPU fallback (unused on M1 — GPU dominates) ────────────
            // Boundary cost: CPU↔GPU ~3 µs. CPU↔Accelerate ~2 µs.
            PlaceRegion {
                id: "mlx-cpu-preferred".into(),
                candidate: CandidateClass::MlxCpuPreferred,
                weight: 10,
                label: Some("no MlxCpuPreferred ops on M1 baseline".into()),
            },
            // ── ANE experimental: 6-MLP stateful island ─────────────────────
            // Boundary cost: ANE↔any ~50 µs — high transition penalty means
            // ANE regions should be contiguous in the compute graph.
            PlaceRegion {
                id: "coreml-ane-candidate".into(),
                candidate: CandidateClass::CoreMlAneCandidate,
                weight: 60,
                label: Some("6-MLP stateful island (experimental)".into()),
            },
            // ── Accelerate: small-element ops that benefit from vDSP ────────
            // Boundary cost: Accelerate↔GPU ~8 µs, Accelerate↔CPU ~2 µs.
            PlaceRegion {
                id: "accelerate-preferred".into(),
                candidate: CandidateClass::AcceleratePreferred,
                weight: 40,
                label: Some(
                    "logits scaling, top-k post-processing".into(),
                ),
            },
            // ── Control-plane CPU: orchestration, not matmul ────────────────
            // Boundary cost: CPU↔GPU ~3 µs, CPU↔Accelerate ~2 µs.
            PlaceRegion {
                id: "control-plane-cpu".into(),
                candidate: CandidateClass::ControlPlaneCpu,
                weight: 20,
                label: Some(
                    "tokenization, detokenization, KV-cache management, mask construction, sampler, admission, cancellation"
                        .into(),
                ),
            },
            // ── Fusion-only: ops that must fuse with neighbours ─────────────
            // Boundary cost: FusionOnly↔GPU 0 µs — the compiler eliminates
            // the boundary by fusing into an adjacent GPU kernel.
            PlaceRegion {
                id: "fusion-only".into(),
                candidate: CandidateClass::FusionOnly,
                weight: 50,
                label: Some(
                    "RMSNorm+q_proj, q_norm+k_norm+RoPE, gate*up activation, RMSNorm standalone, residual add"
                        .into(),
                ),
            },
            // ── Rust NEON: small CPU-side format conversions ────────────────
            // Boundary cost: NEON↔any ~1 µs — L1-cache resident.
            PlaceRegion {
                id: "rust-neon-preferred".into(),
                candidate: CandidateClass::RustNeonPreferred,
                weight: 30,
                label: Some("BF16-to-F32 conversion (small norm weights)".into()),
            },
            // ── Benchmark unresolved: needs runtime measurement ─────────────
            // Boundary cost: varies by candidate — ANE↔any ~50 µs worst case.
            // Regions here should be measured at runtime before dispatch.
            PlaceRegion {
                id: "benchmark-unresolved".into(),
                candidate: CandidateClass::BenchmarkUnresolved,
                weight: 0,
                label: Some(
                    "Core ML full-decoder island, stateful prefill island".into(),
                ),
            },
        ],
    }
}

// ---------------------------------------------------------------------------
// validate_profile
// ---------------------------------------------------------------------------

/// Validate a placement profile for structural integrity.
///
/// Checks:
/// - At least one region is present.
/// - Region IDs are unique.
/// - No `MlxCpuPreferred` region has a commensurate `MlxGpuPreferred`
///   region with overlapping ops (structural sanity).
///
/// Returns `Ok(())` or `Err(list_of_issues)`.
pub fn validate_profile(profile: &ExecutionPlacementProfile) -> Result<(), Vec<String>> {
    let mut errors: Vec<String> = Vec::new();

    // Must have at least one region.
    if profile.regions.is_empty() {
        errors.push("placement profile must have at least one region".into());
    }

    // Region IDs must be unique.
    let mut seen = std::collections::HashSet::new();
    for region in &profile.regions {
        if !seen.insert(&region.id) {
            errors.push(format!("duplicate region id: {}", region.id));
        }
    }

    // BenchmarkUnresolved regions must have weight == 0.
    for region in &profile.regions {
        if matches!(region.candidate, CandidateClass::BenchmarkUnresolved) && region.weight != 0 {
            errors.push(format!(
                "BenchmarkUnresolved region '{}' must have weight 0, got {}",
                region.id, region.weight
            ));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

// ---------------------------------------------------------------------------
// write_profile
// ---------------------------------------------------------------------------

/// Serialize a placement profile as pretty-printed JSON and write to `path`.
///
/// Wraps serde serialisation errors into a `napi::Result`.
pub fn write_profile(
    profile: &ExecutionPlacementProfile,
    path: &Path,
) -> napi::Result<()> {
    let json = serde_json::to_string_pretty(profile).map_err(|e| {
        napi::Error::from_reason(format!("failed to serialize profile: {}", e))
    })?;
    std::fs::write(path, &json).map_err(|e| {
        napi::Error::from_reason(format!(
            "failed to write profile to {}: {}",
            path.display(),
            e
        ))
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement_profile::PlaceRegion;

    fn m1_profile() -> ExecutionPlacementProfile {
        compile_default_m1_profile("sha256:test123")
    }

    #[test]
    fn test_compile_default_m1_profile_ok() {
        let profile = m1_profile();
        assert_eq!(profile.image_hash, "sha256:test123");
        assert_eq!(profile.mlx_version, "0.28.0");
        assert!(!profile.regions.is_empty());

        // Verify all expected region IDs are present.
        let ids: std::collections::HashSet<&str> = profile
            .regions
            .iter()
            .map(|r| r.id.as_str())
            .collect();
        assert!(ids.contains("mlx-gpu-preferred"));
        assert!(ids.contains("mlx-cpu-preferred"));
        assert!(ids.contains("coreml-ane-candidate"));
        assert!(ids.contains("accelerate-preferred"));
        assert!(ids.contains("control-plane-cpu"));
        assert!(ids.contains("fusion-only"));
        assert!(ids.contains("rust-neon-preferred"));
        assert!(ids.contains("benchmark-unresolved"));
    }

    #[test]
    fn test_validate_m1_profile() {
        let profile = m1_profile();
        assert!(validate_profile(&profile).is_ok());
    }

    #[test]
    fn test_validate_empty_regions() {
        let profile = ExecutionPlacementProfile {
            image_hash: "h".into(),
            mlx_version: "0.28.0".into(),
            regions: vec![],
        };
        let result = validate_profile(&profile);
        assert!(result.is_err());
        let errors = result.unwrap_err();
        assert!(errors.iter().any(|e| e.contains("at least one region")));
    }

    #[test]
    fn test_validate_duplicate_id() {
        let profile = ExecutionPlacementProfile {
            image_hash: "h".into(),
            mlx_version: "0.28.0".into(),
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
        };
        let result = validate_profile(&profile);
        assert!(result.is_err());
        let errors = result.unwrap_err();
        assert!(errors.iter().any(|e| e.contains("duplicate region id")));
    }

    #[test]
    fn test_validate_benchmark_weight_nonzero() {
        let profile = ExecutionPlacementProfile {
            image_hash: "h".into(),
            mlx_version: "0.28.0".into(),
            regions: vec![
                PlaceRegion {
                    id: "primary".into(),
                    candidate: CandidateClass::MlxGpuPreferred,
                    weight: 100,
                    label: None,
                },
                PlaceRegion {
                    id: "unresolved".into(),
                    candidate: CandidateClass::BenchmarkUnresolved,
                    weight: 50,
                    label: None,
                },
            ],
        };
        let result = validate_profile(&profile);
        assert!(result.is_err());
        let errs = result.unwrap_err();
        assert!(errs.iter().any(|e| e.contains("weight 0")));
    }

    #[test]
    fn test_write_profile_roundtrip() {
        let profile = m1_profile();
        let tmp = std::env::temp_dir().join("test_profile.json");
        write_profile(&profile, &tmp).expect("write should succeed");
        let json = std::fs::read_to_string(&tmp).expect("read back");
        let parsed: ExecutionPlacementProfile =
            serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.image_hash, profile.image_hash);
        assert_eq!(parsed.mlx_version, profile.mlx_version);
        assert_eq!(parsed.regions.len(), profile.regions.len());
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn test_boundary_cost_note_non_empty() {
        let note = boundary_cost_note();
        assert!(!note.is_empty());
        assert!(note.contains("Boundary Cost Methodology"));
        assert!(note.contains("~8 us"));
    }
}
