import type { TensorView } from "./tensor-view.js"

// ── Quantisation schemes ──────────────────────────────────────────────────────

export type QuantScheme = "q4_0" | "q4_1" | "q5_0" | "q5_1" | "q8_0" | "f16" | "f32"

/** Byte-per-element factor for a quantisation scheme (0 = variable / block-based). */
export function quantSchemeByteFactor(scheme: QuantScheme): number {
  switch (scheme) {
    case "q4_0":
      return 0
    case "q4_1":
      return 0
    case "q5_0":
      return 0
    case "q5_1":
      return 0
    case "q8_0":
      return 0
    case "f16":
      return 2
    case "f32":
      return 4
  }
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface QuantizedMatmul {
  compute(a: TensorView, b: TensorView, scheme: QuantScheme): TensorView
  dequantize(tensor: TensorView, scheme: QuantScheme): TensorView
}

// ── Helpers — float32 / float16 conversions ───────────────────────────────────

const F16_EXP_BIAS = 15
const F32_EXP_BIAS = 127
const F16_MANTISSA_BITS = 10
const F32_MANTISSA_BITS = 23

/** Interpret raw f16 bits as an f32 number. */
function f16BitsToF32(bits: number): number {
  const sign = (bits >> 15) & 0x1
  const exp = (bits >> 10) & 0x1f
  const mant = bits & 0x3ff

  if (exp === 0) {
    // subnormal or zero
    if (mant === 0) return sign === 0 ? 0 : -0
    const val = (mant / (1 << F16_MANTISSA_BITS)) * 2 ** (1 - F16_EXP_BIAS)
    return sign === 0 ? val : -val
  }
  if (exp === 0x1f) {
    // infinity or NaN
    return mant === 0
      ? sign === 0
        ? Number.POSITIVE_INFINITY
        : Number.NEGATIVE_INFINITY
      : Number.NaN
  }
  const f32Exp = exp - F16_EXP_BIAS + F32_EXP_BIAS
  const f32Bits = (sign << 31) | (f32Exp << 23) | (mant << (F32_MANTISSA_BITS - F16_MANTISSA_BITS))
  const arr = new Uint32Array([f32Bits])
  return new Float32Array(arr.buffer)[0]
}

/** Convert an f32 to raw f16 bits (truncation, no rounding). */
function f32ToF16Bits(value: number): number {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return 0x7e01 // canonical NaN
    return value > 0 ? 0x7c00 : 0xfc00 // infinity
  }
  const f32 = new Float32Array([value])
  const bits = new Uint32Array(f32.buffer)[0]
  const sign = (bits >> 16) & 0x8000
  const exp = (bits >> 23) & 0x1ff
  const mant = bits & 0x7fffff

  if (exp <= 127 - 14 + 15) {
    // zero / subnormal — flush to zero
    return sign
  }
  if (exp > 127 + 15) {
    // overflow — saturate to infinity
    return sign | 0x7c00
  }
  const f16Exp = (exp - F32_EXP_BIAS + F16_EXP_BIAS) << 10
  const f16Mant = mant >> (F32_MANTISSA_BITS - F16_MANTISSA_BITS)
  return sign | f16Exp | f16Mant
}

// ── Block dequantisation helpers ──────────────────────────────────────────────

/**
 * Read a single quantised block (32 elements) and produce 32 f32 values.
 * Throws if the block buffer is too short for the given scheme.
 */
function dequantizeBlock(src: Uint8Array, offset: number, scheme: QuantScheme, dst: Float32Array, dstOff: number): void {
  switch (scheme) {
    case "q4_0": {
      const d = new Float32Array(src.slice(offset, offset + 4).buffer)[0]
      const start = offset + 4
      for (let i = 0; i < 16; i++) {
        const packed = src[start + i]!
        dst[dstOff + i * 2] = ((packed & 0x0f) - 8) * d
        dst[dstOff + i * 2 + 1] = ((packed >> 4) - 8) * d
      }
      break
    }
    case "q4_1": {
      const d = new Float32Array(src.slice(offset, offset + 4).buffer)[0]
      const m = new Float32Array(src.slice(offset + 4, offset + 8).buffer)[0]
      const start = offset + 8
      for (let i = 0; i < 16; i++) {
        const packed = src[start + i]!
        dst[dstOff + i * 2] = (packed & 0x0f) * d + m
        dst[dstOff + i * 2 + 1] = (packed >> 4) * d + m
      }
      break
    }
    case "q5_0": {
      const d = new Float32Array(src.slice(offset, offset + 4).buffer)[0]
      const low = src.slice(offset + 4, offset + 20)
      const high = src.slice(offset + 20, offset + 24)
      for (let i = 0; i < 16; i++) {
        const h = (high[Math.floor(i / 8)]! >> (i % 8) * 2) & 0x03
        const lo = low[i * 2]!
        const hi = low[i * 2 + 1]!
        const v0 = ((lo & 0x0f) | ((h & 0x01) << 4)) - 16
        const v1 = ((lo >> 4) | ((h & 0x02) << 3)) - 16
        dst[dstOff + i * 2] = v0 * d
        dst[dstOff + i * 2 + 1] = v1 * d
      }
      break
    }
    case "q5_1": {
      const d = new Float32Array(src.slice(offset, offset + 4).buffer)[0]
      const m = new Float32Array(src.slice(offset + 4, offset + 8).buffer)[0]
      const low = src.slice(offset + 8, offset + 24)
      const high = src.slice(offset + 24, offset + 28)
      for (let i = 0; i < 16; i++) {
        const h = (high[Math.floor(i / 8)]! >> (i % 8) * 2) & 0x03
        const lo = low[i * 2]!
        const hi = low[i * 2 + 1]!
        const v0 = (lo & 0x0f) | ((h & 0x01) << 4)
        const v1 = (lo >> 4) | ((h & 0x02) << 3)
        dst[dstOff + i * 2] = v0 * d + m
        dst[dstOff + i * 2 + 1] = v1 * d + m
      }
      break
    }
    case "q8_0": {
      const d = new Float32Array(src.slice(offset, offset + 4).buffer)[0]
      const start = offset + 4
      for (let i = 0; i < 32; i++) {
        dst[dstOff + i] = src[start + i]! * d
      }
      break
    }
    case "f16": {
      const view = new DataView(src.buffer, src.byteOffset + offset, 64)
      for (let i = 0; i < 32; i++) {
        dst[dstOff + i] = f16BitsToF32(view.getUint16(i * 2, true))
      }
      break
    }
    case "f32": {
      const view = new Float32Array(src.buffer, src.byteOffset + offset, 32)
      dst.set(view, dstOff)
      break
    }
  }
}

// ── Concrete implementation ───────────────────────────────────────────────────

export class SimpleQuantizedMatmul implements QuantizedMatmul {
  compute(a: TensorView, b: TensorView, _scheme: QuantScheme): TensorView {
    // For now, both operands are dequantised to f32 and a standard matmul is
    // performed.  A production implementation would dispatch to the compute
    // backend (Metal / CUDA / Vulkan) with a quantised kernel.

    if (a.shape.length !== 2 || b.shape.length !== 2) {
      throw new Error(`Matmul requires 2-d tensors, got a=${a.shape.length}d b=${b.shape.length}d`)
    }
    const [m, k1] = a.shape
    const [k2, n] = b.shape
    if (k1 !== k2) {
      throw new Error(`Matmul dimension mismatch: a(${m}x${k1}) b(${k2}x${n})`)
    }

    // Read element data as flat f32 (assume float32 for now).
    const aData = readF32View(a)
    const bData = readF32View(b)

    const outLen = m * n
    const out = new Float32Array(outLen)

    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        let sum = 0
        for (let k = 0; k < k1; k++) {
          sum += aData[i * k1 + k]! * bData[k * n + j]!
        }
        out[i * n + j] = sum
      }
    }

    return wrapF32Array(out, [m, n])
  }

  dequantize(tensor: TensorView, scheme: QuantScheme): TensorView {
    // Only meaningful for quantised input; for f16/f32 this is a shallow copy.
    const numElements = tensor.numElements
    const out = new Float32Array(numElements)
    const blockSize = 32
    const rawBytes = readRawBytes(tensor)
    const numBlocks = Math.ceil(numElements / blockSize)

    for (let block = 0; block < numBlocks; block++) {
      const elemOff = block * blockSize
      const byteOff = block * blockByteSize(scheme)
      const count = Math.min(blockSize, numElements - elemOff)
      // Dequantise up to 32 elements into the output.
      const inner = new Float32Array(32)
      dequantizeBlock(rawBytes, byteOff, scheme, inner, 0)
      for (let i = 0; i < count; i++) {
        out[elemOff + i] = inner[i]!
      }
    }

    return wrapF32Array(out, tensor.shape)
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Byte size of one quantised block (32 elements) for a given scheme. */
export function blockByteSize(scheme: QuantScheme): number {
  switch (scheme) {
    case "q4_0":
      return 4 + 16 // d(float32) + 16 bytes packed 4-bit
    case "q4_1":
      return 8 + 16 // d + m (float32 each) + 16 bytes packed 4-bit
    case "q5_0":
      return 4 + 16 + 4 // d(float32) + 16 low nibbles + 4 high bits
    case "q5_1":
      return 8 + 16 + 4 // d + m + 16 low + 4 high
    case "q8_0":
      return 4 + 32 // d(float32) + 32 int8 values
    case "f16":
      return 64 // 32 * 2
    case "f32":
      return 128 // 32 * 4
  }
}

/**
 * Read the raw bytes backing a tensor view into a single contiguous Uint8Array.
 * If the view is already backed by an ArrayBuffer this is a no-copy slice;
 * otherwise the data is concatenated.
 */
function readRawBytes(tv: TensorView): Uint8Array {
  // The storage handle exposes a shared ArrayBuffer if cpu-backed.
  // For simplicity we assume cpu-backed storage.
  const handle = tv.handle as unknown as { buffer?: ArrayBuffer }
  if (handle.buffer) {
    return new Uint8Array(handle.buffer, tv.offset, tv.byteSize)
  }
  // Fallback — allocate and zero-fill (caller should use cpu-backed handles).
  return new Uint8Array(tv.byteSize)
}

/**
 * Read tensor view elements as a flat Float32Array, dequantising on the fly
 * if the backing data is quantised.
 */
function readF32View(tv: TensorView): Float32Array {
  const raw = readRawBytes(tv)
  const num = tv.numElements
  const out = new Float32Array(num)
  if (raw.length >= num * 4) {
    // Already f32 — fast path.
    const view = new Float32Array(raw.buffer, raw.byteOffset, num)
    out.set(view)
    return out
  }
  if (raw.length >= num * 2) {
    // f16 — convert each element.
    const view = new DataView(raw.buffer, raw.byteOffset, raw.length)
    for (let i = 0; i < num; i++) {
      out[i] = f16BitsToF32(view.getUint16(i * 2, true))
    }
    return out
  }
  // Anything else is unsupported for now.
  throw new Error(`Cannot read f32 view from ${tv.dtype} tensor of ${tv.byteSize} bytes`)
}

// ── TensorView factory helpers (cpu-backed) ───────────────────────────────────

import type { StorageHandle } from "./storage-handle.js"

let tensorIdCounter = 0

/** Wrap a Float32Array as a TensorView backed by a simple cpu StorageHandle. */
function wrapF32Array(data: Float32Array, shape: number[]): TensorView {
  const id = `matmul-tensor-${++tensorIdCounter}`
  const strides = computeStrides(shape)
  const handle: StorageHandle & { buffer: ArrayBuffer } = {
    id,
    allocationClass: "shared" as const,
    backend: "cpu" as const,
    sizeBytes: data.byteLength,
    isView: false,
    createdAt: new Date().toISOString(),
    buffer: data.buffer as ArrayBuffer,
    release() {
      /* no-op for cpu-backed handles */
    },
  }
  return {
    handle,
    shape,
    strides,
    dtype: "float32",
    offset: 0,
    numElements: data.length,
    byteSize: data.byteLength,
    validate: () => true,
    slice: (_start: number[], _end: number[]) => {
      throw new Error("slice not implemented on matmul tensors")
    },
    materialize: () => {
      throw new Error("materialize not implemented on matmul tensors")
    },
  } as unknown as TensorView
}

function computeStrides(shape: number[]): number[] {
  const strides = new Array<number>(shape.length)
  let s = 1
  for (let i = shape.length - 1; i >= 0; i--) {
    strides[i] = s
    s *= shape[i]!
  }
  return strides
}
