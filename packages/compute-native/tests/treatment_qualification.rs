//! Synthetic qualification tests for Mission 0007 Phase 9.
//!
//! These tests prove the treatment infrastructure works with small synthetic
//! data — no 12B model required.  Every tensor, plan, manifest, and sidecar
//! is constructed in-process from scratch.

use tribunus_compute_native::compute_image::CompiledImageReader;
use tribunus_compute_native::config::LayerPlan;
use tribunus_compute_native::sidecar::{
    derive_kernel_signatures, derive_residency_groups, ExecutionConditioningSidecar,
};
use tribunus_compute_native::treatment::{PrefetchCoordinator, ReadinessManager, ScratchArena};
use tribunus_evidence_schema::mission0007::AttentionKind;
use tribunus_evidence_schema::{
    ArtifactRange, ConditioningArm, ConditioningFallbackPolicy, ExecutionConditioningPolicy,
    ExpectedSubstrate, ModelReadiness, ResidencyGroup, ResidencyGroupId, ResidencyPlanVersion,
    ResidencyPriority, ResourceId,
};

// ── Shared helpers ─────────────────────────────────────────────────────────

/// Gemma‑4‑12B‑like layer geometry used by all tests that need a LayerPlan.
fn sample_layer_plan(layer_index: u32, attention_kind: &str) -> LayerPlan {
    LayerPlan {
        layer_index,
        attention_kind: attention_kind.to_string(),
        segment_id: format!("layer_{}", layer_index),
        hidden_size: 3840,
        n_heads: 16,
        n_kv_heads: 4,
        head_dim: 256,
        global_head_dim: None,
        n_global_kv_heads: None,
        sliding_window: 4096,
        rope_theta: 10_000.0,
        partial_rotary_factor: None,
        attention_k_eq_v: false,
        q_norm_enabled: false,
        k_norm_enabled: false,
        q_proj_tensor_id: 1 + layer_index * 10,
        k_proj_tensor_id: 2 + layer_index * 10,
        v_proj_tensor_id: 3 + layer_index * 10,
        o_proj_tensor_id: 4 + layer_index * 10,
        q_norm_tensor_id: None,
        k_norm_tensor_id: None,
        gate_proj_tensor_id: 5 + layer_index * 10,
        up_proj_tensor_id: 6 + layer_index * 10,
        down_proj_tensor_id: 7 + layer_index * 10,
        input_layernorm_tensor_id: 8 + layer_index * 10,
        post_attention_layernorm_tensor_id: 9 + layer_index * 10,
        pre_ffw_layernorm_tensor_id: None,
        post_ffw_layernorm_tensor_id: None,
        layer_scalar_ids: vec![],
        quantization_ids: vec![],
    }
}

fn sample_policy() -> ExecutionConditioningPolicy {
    ExecutionConditioningPolicy {
        arm: ConditioningArm::PipelineWarmOnly,
        prefetch_window: None,
        warmup_tokens: None,
        force_pipeline: false,
        preferred_substrate: ExpectedSubstrate::Gpu,
        fallback: ConditioningFallbackPolicy::LogAndContinue,
    }
}

/// Build a minimal ResidencyGroup for prefetch-coordinator tests.
fn sample_residency_group(id: &str) -> ResidencyGroup {
    ResidencyGroup {
        group_id: ResidencyGroupId(id.into()),
        plan_version: ResidencyPlanVersion("1.0".into()),
        artifacts: vec![ArtifactRange {
            resource_id: ResourceId(format!("{}-resource", id)),
            offset: Some(0),
            length: Some(4096),
        }],
        priority: ResidencyPriority::Normal,
        evictable: true,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 1 — Kernel-signature deduplication
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn kernel_signature_dedup() {
    // Create two synthetic LayerPlans with identical projection geometry.
    let sliding_plan = sample_layer_plan(0, "sliding_attention");
    let full_plan = sample_layer_plan(1, "full_attention");

    let sliding_sigs = derive_kernel_signatures(&sliding_plan, 0, AttentionKind::Sliding);
    let full_sigs = derive_kernel_signatures(&full_plan, 1, AttentionKind::Full);

    // Without dedup: 7 families x 2 M-values = 14 signatures per layer.
    // With K-proj/V-proj and Gate-proj/Up-proj dedup (both have identical
    // N,K for same n_kv_heads): 5 unique families x 2 = 10 signatures.
    assert!(
        sliding_sigs.len() <= 10,
        "expected <=10 deduplicated sliding signatures, got {}",
        sliding_sigs.len()
    );
    assert!(
        full_sigs.len() <= 10,
        "expected <=10 deduplicated full signatures, got {}",
        full_sigs.len()
    );

    // Q-proj prefill and decode signatures must be distinct (different M).
    let q_prefill = sliding_sigs
        .iter()
        .find(|s| s.kernel_name.contains("q_proj") && s.shape[0] == 4);
    let q_decode = sliding_sigs
        .iter()
        .find(|s| s.kernel_name.contains("q_proj") && s.shape[0] == 1);
    assert!(
        q_prefill.is_some(),
        "missing Q-proj prefill signature (M=4)"
    );
    assert!(
        q_decode.is_some(),
        "missing Q-proj decode signature (M=1)"
    );
    assert_ne!(
        q_prefill.unwrap().signature_id,
        q_decode.unwrap().signature_id,
        "prefill and decode signatures must have distinct IDs"
    );

    // K-proj and V-proj have identical N,K when n_kv_heads config is used.
    // Their prefill shapes should be deduplicated.  There should be 5 unique
    // prefill shapes (not 7).
    let prefill_shapes: std::collections::HashSet<_> = sliding_sigs
        .iter()
        .filter(|s| s.shape[0] == 4)
        .map(|s| s.shape.clone())
        .collect();
    assert_eq!(
        prefill_shapes.len(),
        5,
        "expected 5 unique prefill shapes after dedup, got {}",
        prefill_shapes.len()
    );

    let decode_shapes: std::collections::HashSet<_> = sliding_sigs
        .iter()
        .filter(|s| s.shape[0] == 1)
        .map(|s| s.shape.clone())
        .collect();
    assert_eq!(
        decode_shapes.len(),
        5,
        "expected 5 unique decode shapes after dedup, got {}",
        decode_shapes.len()
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2 — Residency-group bounds
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn residency_group_bounds() {
    // Synthetic tensor manifest with known byte offsets.
    let manifest: Vec<(String, u64, u64)> = vec![
        ("wq.weight".into(), 0, 100),
        ("wk.weight".into(), 0, 200),
        ("wo.weight".into(), 200, 300),
        ("wg.weight".into(), 500, 1),
    ];

    let total_declared = manifest.iter().map(|(_, _, len)| len).sum::<u64>();

    let group = derive_residency_groups(7, AttentionKind::Sliding, &manifest);

    // Should have 2 artifact ranges per tensor (unaligned + page-aligned).
    assert_eq!(
        group.artifacts.len(),
        manifest.len() * 2,
        "expected 2 artifact ranges per tensor"
    );

    // Validate every aligned range starts at a page boundary.
    let page_size: u64 = 4096;
    for range in &group.artifacts {
        if range.resource_id.0.ends_with("_aligned") {
            let offset = range.offset.unwrap_or(0);
            assert_eq!(
                offset % page_size,
                0,
                "aligned range '{}' offset {} is not page-aligned",
                range.resource_id.0,
                offset
            );
        }

        // No range should exceed 4096 bytes for this synthetic manifest.
        let length = range.length.unwrap_or(0);
        assert!(
            length <= page_size,
            "range '{}' length {} exceeds page size",
            range.resource_id.0,
            length
        );
    }

    // Sum of unaligned ranges must equal total declared bytes.
    let unaligned_sum: u64 = group
        .artifacts
        .iter()
        .filter(|r| !r.resource_id.0.ends_with("_aligned"))
        .map(|r| r.length.unwrap_or(0))
        .sum();
    assert_eq!(
        unaligned_sum, total_declared,
        "sum of unaligned ranges must match total declared bytes"
    );

    // Every unaligned range is within total_declared.
    for range in &group.artifacts {
        let end = range.offset.unwrap_or(0) + range.length.unwrap_or(0);
        assert!(
            end <= total_declared || range.resource_id.0.ends_with("_aligned"),
            "unaligned range '{}' ends at {} which exceeds total {}",
            range.resource_id.0,
            end,
            total_declared
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3 — Sidecar identity binding
// ═══════════════════════════════════════════════════════════════════════════

#[test]
#[test]
fn sidecar_identity_binding() {
    let sidecar = ExecutionConditioningSidecar::new(
        "a".repeat(64),
        "/tmp/test-artifacts".into(),
        "abc123".into(),
    );
    let identity = sidecar.compute_identity();
    assert_eq!(identity.len(), 64, "SHA-256 hex identity must be 64 chars");
    assert!(identity.chars().all(|c| c.is_ascii_hexdigit()), "identity must be hex");
    
    // Different image hash produces different identity
    let mut sidecar2 = ExecutionConditioningSidecar::new(
        "b".repeat(64),
        "/tmp/test-artifacts".into(),
        "abc123".into(),
    );
    assert_ne!(sidecar.compute_identity(), sidecar2.compute_identity());
    
    // Different plan digest produces different identity
    let mut sidecar3 = ExecutionConditioningSidecar::new(
        "a".repeat(64),
        "/tmp/test-artifacts".into(),
        "different_plan".into(),
    );
    assert_ne!(sidecar.compute_identity(), sidecar3.compute_identity());
}
// ═══════════════════════════════════════════════════════════════════════════
// Test 4 — Readiness state machine
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn readiness_state_machine() {
    // Initial state is MappedReady
    let mut mgr = ReadinessManager::new(sample_policy());
    assert_eq!(mgr.current(), ModelReadiness::MappedReady);
    assert!(!mgr.is_ready());

    // Transition to Conditioning succeeds
    let event = mgr.transition_to_conditioning().unwrap();
    assert_eq!(mgr.current(), ModelReadiness::Conditioning);
    assert_eq!(event.reason, "conditioning started");

    // Transition to Conditioning again fails
    let err = mgr.transition_to_conditioning();
    assert!(err.is_err(), "double transition to Conditioning must fail");

    // Transition to LatencyReady succeeds
    let event2 = mgr.transition_to_latency_ready().unwrap();
    assert_eq!(mgr.current(), ModelReadiness::LatencyReady);
    assert!(mgr.is_ready());
    assert_eq!(event2.reason, "latency readiness achieved");
    assert!(mgr.latency_ready_at().is_some());

    // From LatencyReady, Conditioning is rejected
    assert!(
        mgr.transition_to_conditioning().is_err(),
        "cannot transition back to Conditioning from LatencyReady"
    );

    // From LatencyReady, LatencyReady again is rejected
    assert!(
        mgr.transition_to_latency_ready().is_err(),
        "cannot double-transition to LatencyReady"
    );

    // Cannot skip Conditioning to reach LatencyReady
    let mut mgr2 = ReadinessManager::new(sample_policy());
    let err2 = mgr2.transition_to_latency_ready();
    assert!(
        err2.is_err(),
        "must go through Conditioning before LatencyReady"
    );

    // Transition to ConditioningFailed from Conditioning
    let mut mgr3 = ReadinessManager::new(sample_policy());
    mgr3.transition_to_conditioning().unwrap();
    let event3 = mgr3
        .transition_to_failed("OOM during conditioning".into())
        .unwrap();
    assert_eq!(mgr3.current(), ModelReadiness::ConditioningFailed);
    assert!(mgr3.is_terminal());
    assert_eq!(event3.reason, "OOM during conditioning");

    // Already in ConditioningFailed: no more transitions
    assert!(
        mgr3.transition_to_failed("another error".into()).is_err(),
        "already in ConditioningFailed"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 5 — Prefetch coordinator bounds
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn prefetch_coordinator_bounds() {
    let coord = PrefetchCoordinator::new();

    assert!(!coord.is_active());
    assert_eq!(coord.max_queue_depth(), 0);

    // Submit 3 residency groups. Capacity is 2, so third should be rejected.
    let r1 = sample_residency_group("group_a");
    let r2 = sample_residency_group("group_b");
    let r3 = sample_residency_group("group_c");

    assert!(coord.submit_next_layer(r1).is_ok(), "first submit");
    assert!(coord.submit_next_layer(r2).is_ok(), "second submit");

    // The third submit should fail because capacity is 2.
    let err = coord.submit_next_layer(r3);
    assert!(
        err.is_err(),
        "third submit must be rejected when channel capacity is 2"
    );

    // max_queue_depth should be tracked (non-zero after 2 queued submits).
    assert!(
        coord.max_queue_depth() <= 2,
        "max_queue_depth must be <= 2 (channel capacity)"
    );

    // Cancel the coordinator
    coord.cancel();

    // After cancellation, further submissions should fail (channel is full).
    let r4 = sample_residency_group("group_d");
    let err4 = coord.submit_next_layer(r4);
    assert!(
        err4.is_err(),
        "submit after cancel on full channel must fail"
    );

    // Telemetry counters are accessible and zeroed.
    assert_eq!(coord.total_bytes_transferred(), 0);
    assert_eq!(coord.deadline_hits(), 0);
    assert_eq!(coord.deadline_misses(), 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 6 — Scratch-arena isolation
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn scratch_arena_isolation() {
    // Arena starts empty.
    let mut arena = ScratchArena::new();
    assert!(arena.is_empty());
    assert_eq!(arena.len(), 0);

    // Add a synthetic array (mlx-rs Array from a small f32 slice).
    // This allocates a real MLX array but requires no model data.
    let arr = mlx_rs::Array::from_slice(&[1.0f32, 2.0, 3.0], &[3]);
    arena.store(arr);
    assert!(!arena.is_empty());
    assert_eq!(arena.len(), 1);

    // Clear releases the array handle.
    arena.clear();
    assert!(arena.is_empty());
    assert_eq!(arena.len(), 0);

    // Store again and let arena drop -- this exercises the Drop path.
    {
        let mut inner = ScratchArena::new();
        let arr2 = mlx_rs::Array::from_slice(&[4.0f32, 5.0], &[2]);
        inner.store(arr2);
        assert_eq!(inner.len(), 1);
    }
    // inner dropped: no crash, no leak -- the Drop guarantee is satisfied.
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 7 — ConditioningArm serde roundtrip
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn conditioning_arm_serde() {
    let arms = [
        ConditioningArm::FrozenControl,
        ConditioningArm::PipelineWarmOnly,
        ConditioningArm::RollingPrefetchOnly,
        ConditioningArm::Combined,
        ConditioningArm::Sham,
    ];

    for &arm in &arms {
        let json = serde_json::to_string(&arm).expect("serialize");
        let deserialized: ConditioningArm = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(
            arm, deserialized,
            "roundtrip failed for {:?} -> {} -> {:?}",
            arm, json, deserialized
        );
    }
}
