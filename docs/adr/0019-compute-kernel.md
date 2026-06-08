# ADR 0019: Tribunus Compute Kernel — Governed, Copy-Honest Accelerator Runtime

## Status
Proposed — June 2026

## Context

Tribunus needs local compute as a first-class runtime subsystem, not as an incidental ML library integration. The current architecture already distinguishes durable authority, coordination, memory, session lifecycle, and runtime capabilities. Local inference, embeddings, reranking, KV-cache management, model execution, and accelerator access should follow the same doctrine. If these are modeled as ad hoc Python scripts, opaque MLX calls, or vendor-specific inference adapters, the system will inherit hidden memory movement, unclear authority boundaries, unreceipted execution, and backend lock-in.

## Decision

Establish a Rust-native Tribunus Compute Kernel as the canonical local compute substrate. The role of the Compute Kernel is not to replace PyTorch, MLX, IREE, Burn, Candle, or CubeCL. Instead, its role is to govern the execution of local intelligence inside Tribunus.

The kernel owns tensor/storage handles, operation graph metadata, backend routing, accelerator capability negotiation, copy/materialization receipts, session-visible compute jobs, and controlled access for plugins and agents.

### Competitive Landscape (Deep Research, June 2026)

**MLX (Apple):** Core is C++ with Python/C/Swift surfaces. Lazy evaluation — arrays materialize only when explicitly needed (eval(), item(), print()), enabling operation fusion. Unified memory on Apple Silicon eliminates CPU↔GPU copies. Metal-backed kernel execution. Zero-copy does not mean zero synchronization — ownership, hazard tracking, command-buffer fences, buffer lifetime discipline, and explicit materialization boundaries are still required.

**Burn + CubeCL (Tracel AI, 2026):** Burn 0.20.0 (Jan 2026) introduced CubeK — kernel library on CubeCL for matmul, convolutions, attention, quantization. Burn 0.21.0: fusion overhead down 5.4× average (8.2× peak). CubeCL: Rust language extension + JIT compiler + runtimes; a single #[cube] kernel compiles to CUDA, HIP, Metal (via wgpu), Vulkan/SPIR-V, WebGPU/WGSL, CPU SIMD. Alpha but production-grade in Burn. Directly maps to Tribunus multi-backend needs.

**Candle (HuggingFace, v0.10.2):** Minimalist Rust ML inference. First-class Device::Cpu/Cuda/Metal. Safetensors loading via VarBuilder. Strong HuggingFace model compatibility (LLaMA, Whisper, T5, YOLO, Stable Diffusion, etc.). WASM support. Valuable as inference-ergonomics reference for Phase 3.

**IREE (Google/Community):** MLIR-based compiler/runtime. Lowers ML programs through unified IR to CUDA, Metal, Vulkan, CPU. Compiler/runtime infrastructure — not app-integrated kernel, but multi-backend IR lowering is directly relevant.

**Apache Arrow C Data Interface:** Zero-copy columnar sharing via ArrowSchema + ArrowArray C structs with release callbacks. C Device Data Interface extends to GPU memory (RAPIDS cuDF). ABI-stable, no dependencies, FFI with Rust/Python/Julia/Go. Model for zero-copy interchange between compute kernel, retrieval buffers, embeddings, and plugin consumers.

**DLPack (dmlc):** Open in-memory tensor interchange. DLTensor (data pointer, DLContext with CPU/CUDA/OpenCL/ROCm/WebGPU types, shape, strides, dtype, byte_offset). DLManagedTensorVersioned with deleter callback. Adopted by PyTorch, TensorFlow, JAX, NumPy, CuPy, TVM. Canonical tensor interchange for cross-framework and cross-plugin sharing.

**Safetensors (HuggingFace):** Safe model weight format: 8-byte header + JSON metadata + contiguous C-order little-endian data block. Zero-copy via mmap; lazy loading; strictly read-only (no arbitrary code). BF16/FP16 native. Weight-loading format for Inference Spine (Phase 3).

### Backend Routing & Heterogeneity

Backend implementations may target the following backends sequentially:
1. **Metal** (first, for Apple Silicon) — `MTLStorageMode.shared` on unified memory; `MTLStorageMode.private` for GPU-exclusive; Metal 4 (2025) adds `MTL4CommandAllocator`, placement sparse resources, direct Tensor compute kernels.
2. **CUDA** — Unified Memory (`cudaMallocManaged`), Pinned (`cudaMallocHost`), Zero-Copy (`cudaHostAllocMapped`). Device-resident buffers + explicit staging for discrete GPUs; zero-copy via mapped pinned memory on integrated (Jetson).
3. **HIP/ROCm** — `hipMallocManaged` with page migration; HMM support on Vega+ GPUs; ROCm 7.2 (CES 2026) with Windows + Ryzen AI 400 Series support.
4. **Intel oneAPI/SYCL or Level Zero** — `malloc_device`/`malloc_host`/`malloc_shared`; Level Zero direct-to-metal control; oneMKL 2026.0 system shared USM.
5. **Vulkan/WebGPU** (eventually, where appropriate)

### Copy Honesty Invariant

Tribunus does not promise universal physical zero-copy, which is false across heterogeneous hardware:
- **Apple Silicon:** `MTLStorageMode.shared` on UMA — no copies, but synchronization required.
- **CUDA discrete:** Managed memory migrates pages; zero-copy via mapped pinned buffers; device memory is separate.
- **HIP/ROCm:** Managed memory with page faulting; HMM enables system allocators.
- **Intel:** `malloc_shared` migrates dynamically; `malloc_device` stays on device.

Instead, we define the invariant as **copy honesty**. Every logical view, materialization, migration, staging operation, layout conversion, host readback, checkpoint write, and plugin-visible buffer grant must be explicit in the runtime model and receipted when it crosses an authority boundary.

### Separation of Powers

* **PGlite** remains the durable authority for receipts, metadata, model registry state, checkpoint manifests, and policy decisions.
* **Valkey** remains the coordination substrate for scheduling, ordering, leasing, and work distribution.
* **Compute Kernel** owns ephemeral accelerator state and execution plans. Tensor buffers are not durable truth by default; only selected checkpoints, model metadata, execution receipts, and declared artifacts become durable.

### Access Governance

Plugins and agents are prevented from gaining opaque access to raw accelerator memory. All compute execution is bound to Tribunus authority receipts.

### Phased Implementation Plan

* **Phase 1: Data Plane.** Focus on storage handles, tensor views, shape/stride metadata, dtype metadata, shared/device/pinned allocation classes, buffer pools, explicit materialization boundaries, and receipts proving whether operations copied or stayed as views. **Gate:** prove that slice, reshape, matmul input, embedding output, and KV-cache append do not copy unless a declared materialization boundary says they copied.
* **Phase 2: Execution Plane.** Add lazy operation graph construction, dependency tracking, command submission, fences/events, backend planning, and CPU/GPU synchronization rules. **Gate:** embedding lookup → RMSNorm → matmul → activation → matmul chain representable lazily and lowered with minimal intermediate allocation.
* **Phase 3: Inference Primitives.** Add model weight loading via safetensors (mmap, lazy loading), quantized matmul path, embeddings, KV cache, sampler boundary, streaming token output, and checkpointable execution state.
### Non-Goals

* Not a general-purpose ML framework
* Not a PyTorch replacement
* Not an MLX fork
* Not a promise of universal physical zero-copy
* Not a training-first research framework

## Consequences

### Positive

* **Defensible Substrate:** Tribunus gains a robust local intelligence substrate rather than a pile of backend-specific inference integrations. The competitive landscape analysis confirms the gap: while Burn/CubeCL, Candle, IREE, and Arrow/DLPack each cover slices, no existing project synthesizes governed local compute with copy-honest data-plane receipts and capability-scoped plugin access.
* **Clean Extensibility:** Creates a clean extension point for future community compute, local/offloaded inference, plugin-scoped acceleration, and reproducible compute receipts. DLPack and Arrow C Device Data Interface provide proven interchange standards for cross-framework tensor sharing.
* **Governed Compute:** Prevents opaque plugin access to raw accelerator memory and aligns compute with Tribunus authority receipts. Each backend (Metal shared vs. CUDA device-resident vs. HIP managed vs. Intel USM) has distinct memory semantics — the copy-honesty contract ensures these differences are visible, not hidden.
* **Backend-Aware Planning:** The runtime can negotiate capabilities per backend: host-visible shared buffers, device-local buffers, external memory import/export, mmap-backed initialization, unified virtual addressing, async copy engines, command-queue events, peer-to-peer transfer. The planner chooses the correct memory lane, not a one-size-fits-all default.

### Negative

* **Increased Complexity:** Requires modeling memory classes (shared/device/pinned/managed/host), buffer ownership, synchronization (fences, events, command-buffer completion), kernel planning, backend feature detection, and receipt semantics from the beginning. The Metal 4 MTL4CommandAllocator, CUDA cudaMemAdvise/cudaMemPrefetchAsync, HIP hipMemAdvise/hipMemPrefetchAsync, and SYCL USM allocation modes all introduce backend-specific tuning surfaces.
* **New Correctness Surface:** Hidden copies, accidental readbacks, stale buffer views, unsafe plugin access, and backend-specific synchronization bugs become new failure modes. MTLStorageMode.managed semantics differ from CUDA managed memory; discrete GPU device-resident allocations differ from Apple Silicon shared allocations — each combination is a test surface.
* **CubeCL Alpha Risk:** CubeCL is the most viable portable Rust GPU-kernel layer but remains alpha with API churn expected. Adopting it as the backend abstraction carries stability risk; direct Metal/CUDA backends may be necessary as fallback.
