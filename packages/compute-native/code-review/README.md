# Backend Coverage Lattice Gate v1 — Code Review Artifacts

**Branch:** `research/opt-0001-decode-attribution`
**Commit:** `4f2f1991` — "backend coverage lattice gate v1"
**Parent:** `c336e6de`

## Summary of Changes

763 insertions, 127 deletions across 7 files implementing the coverage lattice gate:
two orthogonal status axes (`support_tier` + `predict_status`) across 8 graph families × 3 shapes × 3 backends, plus reference authority wiring and MLX phase-split timing.

## Files Modified

| File | Phase | Insertions | Deletions |
|---|---|---|---|
| `backend_adapters/mod.rs` | Phase 1 | 57 | 0 |
| `receipt.rs` | Phase 1, 6 | 36 | 0 |
| `report.rs` | Phase 1 | 145 | 0 |
| `backend_adapters/mlx_adapter.rs` | Phase 2, 6 | 207 | 79 |
| `backend_adapters/accelerate_adapter.rs` | Phase 4 | 157 | 55 |
| `harness.rs` | Phase 2, 3, 5 | 112 | 22 |
| `matrices.rs` | Phase 1-5 | 87 | 0 |

**Files unchanged as expected:** `conformance.rs`, `backend_adapters/coreml_adapter.rs`

## Artifacts

| File | Description |
|---|---|
| `coverage-lattice-gate-v1-review.json` | Full code review with file-by-file analysis, architecture assessment, closure condition evaluation, and recommendations |

## Review Methodology

Manual code review produced because the MCP `tribunus_review_packet_export` / `tribunus_code_review_export` tools were not directly callable as registered MCP tools in the current session. The review covers:

1. All 7 modified files with structural analysis
2. Closure condition assessment (12 conditions, 10 met, 2 runtime-dependent)
3. Architecture risks and strengths
4. Actionable recommendations

## Expected Row Count (Lattice)

| Backend | Families | Shapes | Policies | Rows |
|---|---|---|---|---|
| Core ML | 8 | 3 (small/med/large) | 2 (cpuOnly, cpuAndGPU) | 48 |
| MLX | 8 | 3 | 1 (default) | 24 |
| Accelerate | 8 | 3 | 1 (cpu) | 24 |
| **Total** | | | | **96** |

All 96 rows get reference output hashes populated via Phase 5 wiring. No row has empty status cells.

## Key Design Decisions

1. **String-based status fields** — `predict_status` and `support_tier` are `String` in `DecodeAttributionReceipt` for JSON serialization stability, not enums. Projected to typed values at the `CoverageLatticeRow` level.

2. **assert!() for validation** — `generate_coverage_json()` panics on mixed provenance. Acceptable for CLI pipelines; would need Result for library use.

3. **MLX multi_output returns primary output only** — the second output (input + extra) is constructed but discarded. Reference comparison uses primary output hash only.

4. **Accelerate identity = instant pass** — cold_first_predict_ns=0, output hashes from input data. Correct for memcpy operations.

5. **vDSP FFI in adapter file** — vDSP_vadd/vDSP_vmul declared inside accelerate_adapter.rs rather than in a dedicated FFI module. Working but inconsistent with the accelerate_ffi pattern.
