import type { TensorView } from "./tensor-view.js"
import type { StorageHandle } from "./storage-handle.js"

// ── Result types ──────────────────────────────────────────────────────────────

export interface EmbeddingResult {
  readonly tokenIds: number[]
  readonly embeddings: TensorView // shape: [batch_size, seq_len, dim]
  readonly batchSize: number
}

export interface EmbeddingEngine {
  embed(tokenIds: number[], weights: TensorView): EmbeddingResult
  embedBatch(tokenIds: number[][], weights: TensorView): EmbeddingResult[]
}

// ── Concrete implementation ───────────────────────────────────────────────────

let embeddingTensorCounter = 0

export class SimpleEmbeddingEngine implements EmbeddingEngine {
  embed(tokenIds: number[], weights: TensorView): EmbeddingResult {
    if (weights.shape.length !== 2) {
      throw new Error(`Embedding weights must be 2-d [vocab_size, dim], got ${weights.shape.length}-d`)
    }
    const [vocabSize, dim] = weights.shape

    // Validate token ids are within range.
    for (const id of tokenIds) {
      if (id < 0 || id >= vocabSize) {
        throw new Error(`Token id ${id} out of range [0, ${vocabSize})`)
      }
    }

    const seqLen = tokenIds.length
    const outLen = seqLen * dim
    const out = new Float32Array(outLen)

    // For each token, copy the corresponding row from the weight matrix.
    for (let i = 0; i < seqLen; i++) {
      const row = readWeightRow(weights, tokenIds[i]!)
      const dstOff = i * dim
      for (let j = 0; j < dim; j++) {
        out[dstOff + j] = row[j]!
      }
    }

    const shape = [1, seqLen, dim]
    const view = wrapF32ArrayAsTensor(out, shape)

    return { tokenIds: [...tokenIds], embeddings: view, batchSize: 1 }
  }

  embedBatch(tokenIds: number[][], weights: TensorView): EmbeddingResult[] {
    return tokenIds.map((ids) => this.embed(ids, weights))
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read a single row (token embedding) from weight tensor as a flat Float32Array.
 * Assumes row-major layout with stride = dim along the first axis.
 */
function readWeightRow(weights: TensorView, rowIdx: number): Float32Array {
  const dim = weights.shape[1]!
  const rowByteOffset = weights.offset + rowIdx * dim * (weights.dtype === "float16" ? 2 : 4)
  // Attempt zero-copy via the handle's backing buffer.
  const handle = weights.handle as unknown as { buffer?: ArrayBuffer }
  if (handle.buffer) {
    const byteLen = dim * 4 // we expand f16 → f32 below
    if (weights.dtype === "float32" && byteLen <= handle.buffer.byteLength - rowByteOffset) {
      return new Float32Array(handle.buffer, rowByteOffset, dim)
    }
  }
  // Fallback: read the raw bytes and convert.
  const raw = rawTensorBytes(weights)
  const row = new Float32Array(dim)
  if (weights.dtype === "float16") {
    const view = new DataView(raw.buffer, raw.byteOffset + rowByteOffset, dim * 2)
    for (let i = 0; i < dim; i++) {
      row[i] = f16BitsToF32(view.getUint16(i * 2, true))
    }
  } else {
    const src = new Float32Array(raw.buffer, raw.byteOffset + rowByteOffset, dim)
    row.set(src)
  }
  return row
}

function rawTensorBytes(tv: TensorView): Uint8Array {
  const handle = tv.handle as unknown as { buffer?: ArrayBuffer }
  if (handle.buffer) {
    return new Uint8Array(handle.buffer, tv.offset, tv.byteSize)
  }
  return new Uint8Array(tv.byteSize)
}

// ── f16 ↔ f32 ────────────────────────────────────────────────────────────────

function f16BitsToF32(bits: number): number {
  const sign = (bits >> 15) & 0x1
  const exp = (bits >> 10) & 0x1f
  const mant = bits & 0x3ff
  if (exp === 0) {
    if (mant === 0) return sign === 0 ? 0 : -0
    const val = (mant / 1024) * 2 ** -14
    return sign === 0 ? val : -val
  }
  if (exp === 0x1f) {
    return mant === 0
      ? sign === 0
        ? Number.POSITIVE_INFINITY
        : Number.NEGATIVE_INFINITY
      : Number.NaN
  }
  const f32Exp = exp - 15 + 127
  const f32Bits = (sign << 31) | (f32Exp << 23) | (mant << 13)
  const arr = new Uint32Array([f32Bits])
  return new Float32Array(arr.buffer)[0]
}

// ── TensorView factory ────────────────────────────────────────────────────────

function wrapF32ArrayAsTensor(data: Float32Array, shape: number[]): TensorView {
  const id = `embedding-${++embeddingTensorCounter}`
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
      throw new Error("slice not implemented on embedding tensors")
    },
    materialize: () => {
      throw new Error("materialize not implemented on embedding tensors")
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
