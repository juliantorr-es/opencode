//! Integration test for the compute kernel with Gemma 4 12B weights.
//!
//! This test validates the end-to-end pipeline: load safetensors weights,
//! create a Gemma 4 model, run forward pass, and sample tokens.
//!
//! The test runs in two modes:
//!   - Stub mode (default): validates the TypeScript adapter layer
//!     without requiring the native addon to be built.
//!   - Live mode: set GAMMA_TEST_LIVE=1 and ensure @tribunus/compute-native
//!     is built and the model weights are available.

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  isNativeAvailable,
  detectDefaultDevice,
  getGemma4Config,
  createArrayF32,
  createArrayRaw,
  arrayShape,
  arraySize,
  freeArray,
  drainArrays,
  matmul,
  add,
  multiply,
  loadSafetensors,
  inspectSafetensors,
  gemmaForward,
  gemmaSampleGreedy,
  gemmaGenerate,
  type GemmaConfig,
} from "../src/index.js"

// ── Configuration ────────────────────────────────────────────────────────────

const LIVE_MODE = process.env.GEMMA_TEST_LIVE === "1"

// Path to Gemma 4 12B safetensors weights.
// Download from: https://huggingface.co/mlx-community/gemma-4-12B-it-4bit
const WEIGHTS_PATH =
  process.env.GEMMA_WEIGHTS_PATH ?? "./test-weights/model.safetensors"

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireNative() {
  if (!isNativeAvailable()) {
    throw new Error(
      "Native backend not available. Build it with: " +
        "cd packages/compute-native && bun run build"
    )
  }
}

// ── Stub Mode Tests (always run) ─────────────────────────────────────────────

describe("Native backend detection", () => {
  test("isNativeAvailable returns boolean", () => {
    expect(typeof isNativeAvailable()).toBe("boolean")
  })

  test("detectDefaultDevice returns stub info when native unavailable", () => {
    const info = detectDefaultDevice()
    expect(info.name).toBeString()
    expect(typeof info.available).toBe("boolean")
    expect(info.deviceName).toBeString()
  })

  test("getGemma4Config throws when native unavailable", () => {
    if (isNativeAvailable()) return // skip if live
    expect(() => getGemma4Config()).toThrow("Native backend required")
  })
})

describe("Gemma 4 12B config", () => {
  test("config has expected dimensions", () => {
    if (!isNativeAvailable()) return // skip if stub
    const config: GemmaConfig = getGemma4Config()
    expect(config.nLayers).toBe(48)
    expect(config.nHeads).toBe(32)
    expect(config.nKvHeads).toBe(8)
    expect(config.hiddenSize).toBe(3840)
    expect(config.intermediateSize).toBe(15360)
    expect(config.headDim).toBe(120)
    expect(config.vocabSize).toBe(256128)
    expect(config.ropeTheta).toBe(500000)
    expect(config.maxSeqLen).toBe(131072)
    expect(config.rmsNormEps).toBeCloseTo(1e-6)
  })
})

// ── Live Mode Tests (only when GAMMA_TEST_LIVE=1) ────────────────────────────

describe("Array operations", () => {
  if (!LIVE_MODE) return

  test("createArrayF32 and get shape", () => {
    requireNative()
    const data = new Float32Array([1, 2, 3, 4, 5, 6])
    const handle = createArrayF32(data, [2, 3])
    expect(arrayShape(handle)).toEqual([2, 3])
    expect(arraySize(handle)).toBe(6)
    freeArray(handle)
  })

  test("matmul", () => {
    requireNative()
    // 2x3 @ 3x2 = 2x2
    const a = createArrayF32(new Float32Array([1, 2, 3, 4, 5, 6]), [2, 3])
    const b = createArrayF32(new Float32Array([7, 8, 9, 10, 11, 12]), [3, 2])
    const c = matmul(a, b)
    expect(arrayShape(c)).toEqual([2, 2])
    freeArray(a)
    freeArray(b)
    freeArray(c)
  })

  test("add", () => {
    requireNative()
    const a = createArrayF32(new Float32Array([1, 2, 3]), [3])
    const b = createArrayF32(new Float32Array([4, 5, 6]), [3])
    const c = add(a, b)
    expect(arrayShape(c)).toEqual([3])
    freeArray(a)
    freeArray(b)
    freeArray(c)
  })
})

describe("Safetensors loading", () => {
  if (!LIVE_MODE) return

  test("inspectSafetensors reads header", () => {
    requireNative()
    const info = inspectSafetensors(WEIGHTS_PATH)
    expect(info.tensorCount).toBeGreaterThan(0)
    expect(info.tensors.length).toBe(info.tensorCount)
    // Gemma 4 12B has 48 layers × 7 weights + embedding + norm + lm_head ≈ 340 tensors
    expect(info.tensorCount).toBeGreaterThan(300)
  })

  test("loadSafetensors registers all tensors", () => {
    requireNative()
    const tensors = loadSafetensors(WEIGHTS_PATH)
    expect(tensors.length).toBeGreaterThan(300)
    // Verify key tensors are present
    const names = new Set(tensors.map((t) => t.name))
    expect(names.has("model.embed_tokens.weight")).toBe(true)
    expect(names.has("model.layers.0.self_attn.q_proj.weight")).toBe(true)
    expect(names.has("model.layers.0.self_attn.k_proj.weight")).toBe(true)
    expect(names.has("model.layers.0.self_attn.v_proj.weight")).toBe(true)
    expect(names.has("model.layers.0.self_attn.o_proj.weight")).toBe(true)
    expect(names.has("model.layers.0.mlp.gate_proj.weight")).toBe(true)
    expect(names.has("model.layers.0.mlp.up_proj.weight")).toBe(true)
    expect(names.has("model.layers.0.mlp.down_proj.weight")).toBe(true)
    expect(names.has("model.layers.0.input_layernorm.weight")).toBe(true)
    expect(names.has("model.layers.0.post_attention_layernorm.weight")).toBe(true)
    expect(names.has("model.norm.weight")).toBe(true)
    expect(names.has("lm_head.weight")).toBe(true)

    // Free all handles
    for (const t of tensors) freeArray(t.handle)
  })
})

describe("Gemma 4 inference", () => {
  if (!LIVE_MODE) return

  let weightHandles: Record<string, number>

  beforeAll(() => {
    requireNative()
    const tensors = loadSafetensors(WEIGHTS_PATH)
    weightHandles = {}
    for (const t of tensors) {
      weightHandles[t.name] = t.handle
    }
  })

  test("forward pass on single token", () => {
    // Single token input — decode mode
    const inputIds = new Int32Array([1]) // <bos> or any valid token
    const logitsHandle = gemmaForward(inputIds, weightHandles, 0)
    expect(typeof logitsHandle).toBe("number")
    expect(logitsHandle).toBeGreaterThan(0)

    const shape = arrayShape(logitsHandle)
    // logits should be [1, 1, vocab_size]
    expect(shape[0]).toBe(1)
    expect(shape[1]).toBe(1)
    expect(shape[2]).toBe(256128)

    freeArray(logitsHandle)
  })

  test("forward pass on prompt (prefill)", () => {
    // 4-token prompt
    const inputIds = new Int32Array([1, 2, 3, 4])
    const logitsHandle = gemmaForward(inputIds, weightHandles, 0)
    const shape = arrayShape(logitsHandle)
    expect(shape).toEqual([1, 4, 256128])
    freeArray(logitsHandle)
  })

  test("greedy sampling produces valid token", () => {
    const inputIds = new Int32Array([1, 2, 3])
    const logitsHandle = gemmaForward(inputIds, weightHandles, 0)
    const token = gemmaSampleGreedy(logitsHandle)
    expect(typeof token).toBe("number")
    expect(token).toBeGreaterThanOrEqual(0)
    expect(token).toBeLessThan(256128)
    freeArray(logitsHandle)
  })

  test("generation loop produces sequence", () => {
    const prompt = new Int32Array([1]) // single token prompt
    const tokens: number[] = []
    const maxTokens = 5

    for (const token of gemmaGenerate(prompt, weightHandles, maxTokens)) {
      tokens.push(token)
      expect(token).toBeGreaterThanOrEqual(0)
      expect(token).toBeLessThan(256128)
    }

    expect(tokens.length).toBe(maxTokens)
  })
})

// ── Cleanup ──────────────────────────────────────────────────────────────────

afterAll(() => {
  drainArrays()
})
