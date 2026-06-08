export type { AllocationClass, StorageBackend, DType } from "./types.js"
export { DTypeSizes } from "./types.js"

export type { StorageHandle } from "./storage-handle.js"
export {
  createStorageHandle,
  createViewHandle,
  isValidHandle,
  getHandleRefCount,
  drainAllHandles,
} from "./storage-handle.js"

export type { BufferPool, BufferPoolStats } from "./buffer-pool.js"
export { createBufferPool } from "./buffer-pool.js"

export type {
  MetalAvailability,
  MetalBuffer,
  MetalBackendCapabilities,
} from "./metal-adapter.js"
export {
  MTLStorageMode,
  allocationClassToMTLStorageMode,
  detectMetalAvailability,
  detectMetalBackend,
  allocateMetalBuffer,
  createMetalBufferFromHost,
  releaseMetalBuffer,
} from "./metal-adapter.js"

export type { TensorView, MaterializedTensor } from "./tensor-view.js"

export type { MaterializationKind, MaterializationReceipt } from "./materialization.js"
export type { ComputeOp, OperationGraph } from "./operation-graph.js"
export { createOperationGraph } from "./operation-graph.js"

export type { Fence, ComputeEvent, CommandBuffer } from "./command-buffer.js"
export { createCommandBuffer } from "./command-buffer.js"

export type {
  AcceleratorBackend,
  BackendCapability,
  BackendRouter,
} from "./backend-router.js"
export { detectBackends, createBackendRouter } from "./backend-router.js"

export type { ExecutionReceipt } from "./execution-receipt.js"
export {
  createExecutionReceipt,
  completeReceipt,
  failReceipt,
  cancelReceipt,
} from "./execution-receipt.js"

// ── Inference Primitives ──────────────────────────────────────────────────────
export type { ModelMetadata, ModelLoader } from "./model-loader.js"
export { SimpleModelLoader } from "./model-loader.js"

export type { QuantScheme, QuantizedMatmul } from "./matmul.js"
export { SimpleQuantizedMatmul, blockByteSize, quantSchemeByteFactor } from "./matmul.js"

export type { EmbeddingResult, EmbeddingEngine } from "./embeddings.js"
export { SimpleEmbeddingEngine } from "./embeddings.js"

export type { EvictionPolicy, KVCacheEntry, KVCache } from "./kv-cache.js"
export { SimpleKVCache } from "./kv-cache.js"

export type { TokenStream } from "./streaming.js"
export { ArrayTokenStream, GeneratorTokenStream } from "./streaming.js"

export type { CheckpointState, CheckpointManager } from "./checkpoint.js"
export { SimpleCheckpointManager } from "./checkpoint.js"

export type { InferenceReceipt, InferenceReceiptManager } from "./inference-receipt.js"
export { SimpleInferenceReceiptManager } from "./inference-receipt.js"

// ── Native Backend ───────────────────────────────────────────────────────────
export {
  isNativeAvailable,
  getBackendState,
  requireNative,
  allowDegraded,
  detectDefaultDevice,
  createArrayF32,
  createArrayRaw,
  createScalarF32,
  arrayEval,
  arrayShape,
  arraySize,
  arrayNbytes,
  arrayDataF32,
  freeArray,
  drainArrays,
  matmul,
  add,
  multiply,
  loadSafetensors,
  inspectSafetensors,
  getGemma4Config,
  gemmaForward,
  gemmaSampleGreedy,
  gemmaGenerate,
} from "./native-backend.js"
export type { NativeBackendInfo, LoadedTensor, SafetensorsInfo, TensorInfo, GemmaConfig, BackendState } from "./native-backend.js"