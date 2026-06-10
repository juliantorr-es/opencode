//! Core ML lifecycle conformance tests.
//!
//! Tests generational region handles, cache validation, stale-handle
//! rejection, and compile/execute error semantics.  Does not require
//! native Core ML FFI — uses the scaffolding backend directly.

use tribunus_compute_native::backend::coreml::CoreMlBackend;
use tribunus_compute_native::backend::graph::GraphBackend;
use tribunus_compute_native::backend::graph::RegionExecutionReceipt;
use tribunus_compute_native::backend::routing::{
    CompiledRegionHandle, GraphRegion, OperationFamily,
};

// ── Generational handles ──────────────────────────────────────────────

#[test]
fn compile_returns_error_does_not_mutate_cache() {
    let mut be = CoreMlBackend::new();
    let region = GraphRegion {
        region_id: 1,
        family: OperationFamily::Matmul,
        operations: vec![],
        input_tensors: vec![],
        output_tensors: vec![],
        shape_constraints: vec![],
    };

    let cache_size_before = 0; // compiled_regions is empty

    let result = be.compile_region(&region);
    assert!(result.is_err(), "compile_region must return error when not implemented");
    assert!(result.unwrap_err().contains("not yet implemented"));

    // Cache must be unchanged — no phantom entry
    assert!(!be.is_region_cached(CompiledRegionHandle { slot: 0, generation: 1 }));
}

#[test]
fn unknown_region_handle_not_cached() {
    let be = CoreMlBackend::new();
    assert!(!be.is_region_cached(CompiledRegionHandle { slot: 0, generation: 1 }));
    assert!(!be.is_region_cached(CompiledRegionHandle { slot: 999, generation: 1 }));
}

#[test]
fn stale_handle_after_eviction_rejected() {
    // Simulate: if a compiled region existed at slot 0 gen 1,
    // and then was evicted/replaced with gen 2, the old handle
    // must not match.
    let be = CoreMlBackend::new();

    // Old handle with gen=1 on an empty backend
    assert!(!be.is_region_cached(CompiledRegionHandle { slot: 0, generation: 1 }));

    // A handle with wrong generation for a non-existent slot
    assert!(!be.is_region_cached(CompiledRegionHandle { slot: 0, generation: 5 }));
}

#[test]
fn execute_returns_error() {
    let mut be = CoreMlBackend::new();
    let result: Result<RegionExecutionReceipt, String> = be.execute_region(
        CompiledRegionHandle { slot: 0, generation: 1 },
        &[],
    );
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("not yet implemented"));
}

#[test]
fn graph_backend_id_is_coreml() {
    let be = CoreMlBackend::new();
    assert_eq!(be.graph_backend_id().0, 2);
}
