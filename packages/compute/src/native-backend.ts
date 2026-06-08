//! Native compute backend adapter.
//!
//! Loads the @tribunus/compute-native napi-rs addon when available,
//! with three-state discrimination:
//!
//!   - "available":  addon loaded, MLX verified, compute is real
//!   - "degraded":   addon not built, stubs active — dev/test/CI only
//!   - "required-unavailable": throw — production must fail closed
//!
//! The native backend wraps MLX via mlx-rs, providing GPU-accelerated
//! compute on Apple Silicon. All operations go through an opaque handle
//! registry — TypeScript holds numeric handle ids, Rust manages the
//! underlying MLX arrays with generation-protected slot allocation.

import type { DType } from "./types.js"

// ── Dtype mapping ────────────────────────────────────────────────────────────

const DTYPE_TO_NATIVE: Record<DType, number> = {
  float32: 0,
  float16: 1,
  bfloat16: 2,
  int32: 3,
  int8: 5,
  uint8: 6,
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface NativeBackendInfo {
  readonly name: string
  readonly available: boolean
  readonly deviceName: string
}

export interface LoadedTensor {
  name: string
  handle: number
  shape: number[]
  dtype: string
}

export interface TensorInfo {
  name: string
  shape: number[]
  dtype: string
}

export interface SafetensorsInfo {
  path: string
  tensorCount: number
  tensors: TensorInfo[]
}

export interface GemmaConfig {
  nLayers: number
  nHeads: number
  nKvHeads: number
  hiddenSize: number
  intermediateSize: number
  headDim: number
  vocabSize: number
  ropeTheta: number
  maxSeqLen: number
  rmsNormEps: number
}

// ── Backend State Discrimination ─────────────────────────────────────────────

export type BackendState = "available" | "degraded" | "required-unavailable"

// ── Native module interface ─────────────────────────────────────────────────

interface NativeModule {
  detectDefaultDevice(): NativeBackendInfo
  createArrayF32(data: Float32Array, shape: number[]): number
  createArrayRaw(data: Uint8Array, shape: number[], dtypeId: number): number
  createScalarF32(value: number): number
  arrayEval(handle: number): void
  arrayShape(handle: number): number[]
  arraySize(handle: number): number
  arrayNbytes(handle: number): number
  arrayDataF32(handle: number, out: Float32Array): number
  freeArray(handle: number): void
  drainArrays(): void
  handleCount(): number
  matmul(aHandle: number, bHandle: number): number
  add(aHandle: number, bHandle: number): number
  multiply(aHandle: number, bHandle: number): number
  loadSafetensors(path: string): string
  inspectSafetensors(path: string): string
  gemma412bConfig(): string
  gemmaForward(inputIds: Uint8Array, weightHandles: string, kvOffset: number): number
  gemmaSampleGreedy(logitsHandle: number): number
}

// ── Lazy loader ─────────────────────────────────────────────────────────────

let _native: NativeModule | null = null
let _loadAttempted = false

function getNative(): NativeModule | null {
  if (_loadAttempted) return _native
  _loadAttempted = true
  try {
    _native = require("@tribunus/compute-native") as NativeModule
  } catch {
    // Native module not built — stub/degraded mode
  }
  return _native
}

/** Check if the native backend is available. */
export function isNativeAvailable(): boolean {
  return getNative() !== null
}

/** Get the current backend state. */
export function getBackendState(): BackendState {
  return getNative() !== null ? "available" : "degraded"
}

/**
 * Require the native backend for authority-relevant operations.
 * Throws with "required-unavailable" if the addon is not loaded.
 */
export function requireNative(): NativeModule {
  const n = getNative()
  if (!n) {
    throw new Error(
      "Native backend required but unavailable. " +
        "Build it with: cd packages/compute-native && bun run build. " +
        "If running in development, set ALLOW_DEGRADED_COMPUTE=1 to use stubs."
    )
  }
  return n
}

/** Allow degraded mode for dev/test/CI. */
export function allowDegraded(): boolean {
  return (
    process.env.ALLOW_DEGRADED_COMPUTE === "1" ||
    process.env.NODE_ENV === "test" ||
    process.env.NODE_ENV === "development"
  )
}

// ── Stub implementations ────────────────────────────────────────────────────

function stubDetectDefaultDevice(): NativeBackendInfo {
  return {
    name: "cpu (stub — native addon not built)",
    available: false,
    deviceName: "CPU",
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function detectDefaultDevice(): NativeBackendInfo {
  const n = getNative()
  if (n) return n.detectDefaultDevice()
  return stubDetectDefaultDevice()
}

export function createArrayF32(data: Float32Array, shape: number[]): number {
  return requireNative().createArrayF32(data, shape)
}

export function createArrayRaw(data: Uint8Array, shape: number[], dtype: DType): number {
  return requireNative().createArrayRaw(data, shape, DTYPE_TO_NATIVE[dtype])
}

export function createScalarF32(value: number): number {
  return requireNative().createScalarF32(value)
}

export function arrayEval(handle: number): void {
  requireNative().arrayEval(handle)
}

export function arrayShape(handle: number): number[] {
  return requireNative().arrayShape(handle)
}

export function arraySize(handle: number): number {
  return requireNative().arraySize(handle)
}

export function arrayNbytes(handle: number): number {
  return requireNative().arrayNbytes(handle)
}

export function arrayDataF32(handle: number, out: Float32Array): number {
  return requireNative().arrayDataF32(handle, out)
}

export function freeArray(handle: number): void {
  const n = getNative()
  if (n) n.freeArray(handle)
}

export function drainArrays(): void {
  const n = getNative()
  if (n) n.drainArrays()
}

export function matmul(aHandle: number, bHandle: number): number {
  return requireNative().matmul(aHandle, bHandle)
}

export function add(aHandle: number, bHandle: number): number {
  return requireNative().add(aHandle, bHandle)
}

export function multiply(aHandle: number, bHandle: number): number {
  return requireNative().multiply(aHandle, bHandle)
}

// ── Safetensors Model Loading ────────────────────────────────────────────────

export function loadSafetensors(path: string): LoadedTensor[] {
  return JSON.parse(requireNative().loadSafetensors(path)) as LoadedTensor[]
}

export function inspectSafetensors(path: string): SafetensorsInfo {
  return JSON.parse(requireNative().inspectSafetensors(path)) as SafetensorsInfo
}

// ── Model Configuration ──────────────────────────────────────────────────────

export function getGemma4Config(): GemmaConfig {
  return JSON.parse(requireNative().gemma412bConfig()) as GemmaConfig
}

// ── Inference Pipeline ───────────────────────────────────────────────────────

export function gemmaForward(
  inputIds: Int32Array,
  weightHandles: Record<string, number>,
  kvOffset: number,
): number {
  const bytes = new Uint8Array(inputIds.buffer, inputIds.byteOffset, inputIds.byteLength)
  const handlesJson = JSON.stringify(weightHandles)
  return requireNative().gemmaForward(bytes, handlesJson, kvOffset)
}

export function gemmaSampleGreedy(logitsHandle: number): number {
  return requireNative().gemmaSampleGreedy(logitsHandle)
}

export function* gemmaGenerate(
  promptTokens: Int32Array,
  weightHandles: Record<string, number>,
  maxTokens: number,
): Generator<number> {
  let tokens = promptTokens
  let kvOffset = 0

  // Prefill
  let logitsHandle = gemmaForward(tokens, weightHandles, kvOffset)
  kvOffset += tokens.length

  let nextToken = gemmaSampleGreedy(logitsHandle)
  freeArray(logitsHandle)
  yield nextToken

  // Decode loop
  for (let i = 1; i < maxTokens; i++) {
    tokens = new Int32Array([nextToken])
    logitsHandle = gemmaForward(tokens, weightHandles, kvOffset)
    kvOffset += 1

    nextToken = gemmaSampleGreedy(logitsHandle)
    freeArray(logitsHandle)
    yield nextToken
  }
}
