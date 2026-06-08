
| File | Lines | Role |
|---|---|---|


Core ML stateful model loading works (confirmed with the stateful toy model). Stateful prediction still crashes because `coreml_state.mm` is stubs — real MLState bridge implementation deferred to Phase 12.

Core ML artifact compilation requires a pinned Python 3.13 ARM64 environment with the official coremltools 9.0 binary wheel, not the system Python. The currently selected Python ABI (3.14) is unsupported by Core ML Tools 9.0, so pip did not install a compatible macOS native wheel. The hermetic compiler toolchain at `tools/coreml-compiler/` enforces this contract.

## Frozen ABIs

| Identifier | Version | Description |
|---|---|---|
| `tribunus-iosurface-fp16-arena-v1` | v1 | IOSurface-backed FP16 boundary tensor storage |
| `tribunus-coreml-stateful-island-v1` | v1 | Core ML stateful island execution contract |
| `tribunus-hybrid-compute-image-v1` | v1 | Hybrid MLX/Core ML deployment profile |

## Frozen capability names

Capability names are defined as constants in `capability.rs`. These are the canonical identifiers used in capability reports and hybrid profile validation.

| Constant | Capability |
|---|---|
| `CAP_IOSURFACE_CREATION` | `iosurface_creation` |
| `CAP_IOSURFACE_PIXEL_BUFFER` | `iosurface_pixel_buffer` |
| `CAP_FP16_PIXELBUFFER_MULTIARRAYS` | `fp16_pixelbuffer_multiarrays` |
| `CAP_EXTERNAL_HOST_MEMORY` | `external_host_memory` |
| `CAP_IOSURFACE_FP16_BRIDGE` | `iosurface_fp16_bridge` |
| `CAP_COREML_IOSURFACE_INPUT` | `coreml_iosurface_input` |
| `CAP_COREML_OUTPUT_BACKING` | `coreml_output_backing` |
| `CAP_MLX_IOSURFACE_EXTERNAL_ARRAY` | `mlx_iosurface_external_array` |
| `CAP_MLX_COREML_ROUND_TRIP` | `mlx_coreml_round_trip` |
| `CAP_COREML_STATEFUL_MODELS` | `coreml_stateful_models` |
| `CAP_COREML_MULTIFUNCTION_MODELS` | `coreml_multifunction_models` |
| `CAP_COREML_ASYNC_STATEFUL` | `coreml_async_stateful_prediction` |
| `CAP_ARENA_POOLING` | `arena_pooling` |
| `CAP_STATE_LEASE_ISOLATION` | `state_lease_isolation` |
| `CAP_HYBRID_COMPUTE_IMAGE` | `hybrid_compute_image` |

## Frozen receipt schemas

Receipts are serialized as JSON with the following frozen schemas.

### ArenaCreationReceipt

- `arena_id`: String — UUID-based arena identifier
- `generation`: u64 — monotonic generation counter
- `io_surface_id`: i32 — IOSurfaceGetID()
- `logical_shape`: (u32, u32) — (dim0, dim1)
- `physical_width`: i32 — IOSurface width in pixels
- `physical_height`: i32 — IOSurface height in pixels
- `bytes_per_row`: i32 — CVPixelBufferGetBytesPerRow()
- `total_bytes`: i32 — allocation size in bytes
- `pixel_format`: i32 — kCVPixelFormatType_OneComponent16Half (0x4C303068)
- `profile`: String — always `"IOSurfaceFp16ContiguousV1"`
- `created_at`: String — ISO-8601 or debug-format timestamp

### CoreMlPredictionReceipt

- `job_id`: Uuid
- `model_hash`: String — Core ML artifact hash
- `island_id`: Option<String>
- `input_arena_id`: String
- `input_io_surface_id`: i32
- `input_shape`: (u32, u32)
- `output_arena_id`: String
- `output_io_surface_id`: i32
- `output_shape`: (u32, u32)
- `output_backing_feature`: String — feature name used in outputBackings
- `duration_ms`: u64
- `copy_classification`: enum — `application_copy_free`, `copied_fallback`, `materialized_layout_conversion`, `internal_coreml_staging_unknown`
- `internal_coreml_staging`: bool — always true (unknown) for IOSurface path
- `success`: bool

### HybridJobReceipt

- `job_id`: Uuid
- `session_id`: Uuid
- `compute_image_hash`: String
- `coreml_artifact_hash`: String
- `macos_version`: String
- `capability_report_hash`: String
- `state_id`: Option<String>
- `arena_a_id`: Option<String>
- `arena_b_id`: Option<String>
- `lease_transitions`: Vec<LeaseReceipt>
- `coreml_predictions`: Vec<CoreMlPredictionReceipt>
- `state_mutations`: Vec<StateMutationReceipt>
- `total_duration_ms`: u64
- `application_copy_free`: bool — true when no app-level copies occurred
- `internal_coreml_staging`: bool — always true (unknown)
- `copy_classification`: CopyClassification — the honest combined classification
- `finalizer_count`: u32 — number of finalizer invocations
- `final_arena_state`: String — arena lifecycle state at job completion
- `success`: bool
- `error`: Option<String>

## Qualified paths

### Canonical boundary path (IOSurfaceFp16)

1. MLX writes arena A through external array
2. MLX evaluation completes
3. Ownership transfers to Core ML
4. Core ML reads arena A via MLMultiArray(pixelBuffer:shape:)
5. Core ML writes arena B through outputBackings
6. Core ML prediction completes
7. Ownership transfers to MLX
8. MLX consumes arena B through external array

Copy classification: `application_copy_free = true`, `internal_coreml_staging = unknown`

### Fallback path (ExternalHostMemory)

1. Arena allocated via posix_memalign
2. MLX wraps arena A through mlx_array_new_data_managed
3. Core ML reads arena A via initWithDataPointer:
4. Core ML writes arena B through outputBackings

Copy classification: `copied_fallback` (pointer path may or may not avoid copies)

## Runtime component map

| Component | Module | Status |
|---|---|---|
| Arena allocator | `arena.rs` + `coreml_arena.mm` | Complete |
| Arena lifecycle | `arena_lifecycle.rs` | Complete |
| Arena pool | `arena_pool.rs` | Complete |
| MLX external arrays | `external_array.rs` | Complete |
| Core ML stateless prediction | `coreml_bridge.rs` + `coreml_exec.mm` | Complete |
| Core ML stateful prediction | `coreml_state.rs` + `coreml_state.mm` | Bridge compiled; not runtime-qualified |
| KV cache | `kv_cache.rs` | Implemented (6 tests); not yet runtime-qualified |
| Tokio supervisor | `supervisor.rs` | Complete (skeleton) |
| Capability report | `capability.rs` | Complete |
| Hybrid profile | `hybrid_profile.rs` | Complete |
| Structured errors | `errors.rs` | Complete |
| Receipts | `receipts.rs` | Complete |

## Test coverage

38 tests across 9 modules:

| Module | Tests | Coverage |
|---|---|---|
| arena | 11 | Phases 0-4 (verified), stateful island, ping-pong, host memory, Gemma MLP prediction |
| arena_lifecycle | 3 | All valid + illegal transitions |
| capability | 2 | Detection + serde roundtrip |
| supervisor | 9 | Job lifecycle, workers, cancellation, shutdown |
| arena_pool | 4 | Acquire, release, reuse, budget, max-per-key |
| kv_cache | 6 | Sliding/global eviction, concurrency, clear |
| errors | 3 | Builder pattern, display, variants |
| hybrid_profile | 3 | Serde, validation, tensor flow |
| receipts | 3 | Emitter, classification, serde |

## Deferred to v1.x or v2

- Additional dtypes beyond FP16
- Cross-process IOSurface transport
- Full Gemma Core ML islands
- ANE autotuning
- Video-frame formats
- Multiple concurrent readers per arena
- Arbitrary strided views

## Next steps

## Next steps (ordered by critical path)

1. **Full 48-layer ComputeImage execution** — wire config-driven layer_types, execute all layers, source checkpoint unavailable to runtime.
2. **KV cache integration** — prefill + cached decode; prove cached vs uncached parity over several decode steps.
3. **Mapped no-copy segment residency** — mmap segment files, external MLX arrays over mapped memory, eval-before-unmap, flat residency plateau.
4. **Core ML state qualification** — repeated mutation, two-session isolation, concurrency rejection, cancellation, clean destruction. _Bridge compiles but is not runtime-qualified._
5. **Tokio streaming + cancellation** — bounded event channels, token emission, EOS, supervisor lifecycle.
6. **Core ML MLP placement benchmark** — complete boundary latency (MLX eval → arena transfer → Core ML → transfer back → MLX consume).
7. **Stress + receipt closure** — repeated open/close, cancellation at boundaries, corrupted image rejection, full-lifecycle receipts.
