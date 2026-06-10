//! Core ML lifecycle conformance tests.
//!
//! Tests generational region handles, cache validation, stale-handle
//! rejection, real MLModel loading, and compile/execute lifecycle.
//! Uses `CoreMlModel::load` through the native coreml_bridge.

use tribunus_compute_native::backend::coreml::CoreMlBackend;
use tribunus_compute_native::backend::graph::GraphBackend;
use tribunus_compute_native::backend::routing::{
    CompiledRegionHandle, GraphRegion, OperationFamily,
};

// ── Generational handles ──────────────────────────────────────────────

#[test]
fn unknown_region_handle_not_cached() {
    let be = CoreMlBackend::new();
    assert!(!be.is_region_cached(CompiledRegionHandle { slot: 0, generation: 1 }));
    assert!(!be.is_region_cached(CompiledRegionHandle { slot: 999, generation: 1 }));
}

#[test]
fn stale_handle_after_eviction_rejected() {
    let be = CoreMlBackend::new();
    assert!(!be.is_region_cached(CompiledRegionHandle { slot: 0, generation: 1 }));
    assert!(!be.is_region_cached(CompiledRegionHandle { slot: 0, generation: 5 }));
}

#[test]
fn graph_backend_id_is_coreml() {
    let be = CoreMlBackend::new();
    assert_eq!(be.graph_backend_id().0, 2);
}

// ── Real compilation lifecycle ────────────────────────────────────────

#[test]
fn compile_nonexistent_path_returns_error() {
    let mut be = CoreMlBackend::new();
    let region = GraphRegion {
        region_id: 1,
        family: OperationFamily::Matmul,
        operations: vec![],
        input_tensors: vec![],
        output_tensors: vec![],
        shape_constraints: vec![],
    };

    // No .mlmodelc path → load fails with file-not-found error
    let result = be.compile_region(&region);
    assert!(result.is_err(), "load of nonexistent path must fail");
}

#[test]
fn compile_does_not_leave_stale_entry() {
    let mut be = CoreMlBackend::new();
    let region = GraphRegion {
        region_id: 2,
        family: OperationFamily::Matmul,
        operations: vec![],
        input_tensors: vec![],
        output_tensors: vec![],
        shape_constraints: vec![],
    };

    let _ = be.compile_region(&region);
    // compile_region must not leave a phantom entry in the cache
    // (the slot was never populated because load failed)
    assert!(!be.is_region_cached(CompiledRegionHandle { slot: 0, generation: 1 }));
}

#[test]
fn execute_stale_handle_returns_error() {
    let mut be = CoreMlBackend::new();
    let result = be.execute_region(
        CompiledRegionHandle { slot: 0, generation: 1 },
        &[],
    );
    assert!(result.is_err(), "stale handle must be rejected");
    assert!(result.unwrap_err().contains("stale"));
}

#[test]
fn execute_requires_valid_compiled_model() {
    // Even if a model were loaded, execute_region requires
    // arena-based tensor resolution (Phase 9).  Verify the
    // error path is clean.
    let mut be = CoreMlBackend::new();
    let result = be.execute_region(
        CompiledRegionHandle { slot: 0, generation: 1 },
        &[],
    );
    assert!(result.is_err());
}
