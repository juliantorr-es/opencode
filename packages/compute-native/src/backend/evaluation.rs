//! Evaluation-boundary sweep experiment (Mission 0008).
//!
//! ## Hypothesis
//!
//! MLX's unrestricted full-layer lazy evaluation may be hiding integration
//! cost behind a single evaluation fence.  Tribunus-controlled evaluation
//! groups can reveal where deferred cost accumulates and whether targeted
//! fusion boundaries outperform both extremes.
//!
//! ## Experimental profiles
//!
//! - EVAL-P0 (BackendLazy): full-layer MLX lazy graph
//! - EVAL-P1 (ExplicitRegion): attention + MLP split into two groups
//! - EVAL-P2 (ExplicitRegion): projection-family boundaries
//! - EVAL-P3 (Eager): every operation materialised individually

use super::routing::*;

/// Named evaluation-boundary profile.
#[derive(Debug, Clone)]
pub struct EvaluationSweepProfile {
    pub name: String,
    pub policy: EvaluationPolicy,
    pub description: String,
    pub group_count: usize,
}

/// The four canonical profiles for the evaluation-boundary sweep.
pub fn sweep_profiles() -> Vec<EvaluationSweepProfile> {
    vec![
        EvaluationSweepProfile {
            name: "EVAL-P0".into(),
            policy: EvaluationPolicy::BackendLazy,
            description: "Full-layer MLX lazy graph — one evaluation fence".into(),
            group_count: 1,
        },
        EvaluationSweepProfile {
            name: "EVAL-P1".into(),
            policy: EvaluationPolicy::ExplicitRegion,
            description: "Attention + MLP split into two evaluation groups".into(),
            group_count: 2,
        },
        EvaluationSweepProfile {
            name: "EVAL-P2".into(),
            policy: EvaluationPolicy::ExplicitRegion,
            description: "Projection-family boundaries (qkv, attn, o, mlp)".into(),
            group_count: 4,
        },
        EvaluationSweepProfile {
            name: "EVAL-P3".into(),
            policy: EvaluationPolicy::Eager,
            description: "Every operation materialised individually".into(),
            group_count: 0,
        },
    ]
}

/// Metrics collected per trial.
#[derive(Debug, Clone)]
pub struct EvaluationTrialMetrics {
    pub profile_name: String,
    pub trial_index: u32,
    pub phase: Phase,
    pub layer_index: u32,
    pub total_layer_ns: u64,
    pub graph_build_ns: u64,
    pub eval_calls: usize,
    pub sync_ns: u64,
    pub temporary_bytes: u64,
    pub active_bytes_after: u64,
    pub output_correct: bool,
}

/// Aggregate conclusion.
#[derive(Debug, Clone)]
pub enum SweepConclusion {
    LazyFastestButOpaque,
    PartitionOptimal { profile_name: String, improvement_pct: f64 },
    EagerFastest { improvement_pct: f64 },
    Indeterminate,
}
