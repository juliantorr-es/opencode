import type { DType } from "./types.js"
import { DTypeSizes } from "./types.js"
import type { StorageHandle } from "./storage-handle.js"
import type { MaterializationReceipt } from "./materialization.js"

/** A fully-materialized tensor returned by TensorView.materialize(). */
export interface MaterializedTensor {
  readonly view: TensorView
  readonly receipt: MaterializationReceipt
}

/** A typed, N-dimensional view over a region of a StorageHandle. */
export interface TensorView {
  /** The backing storage handle. */
  readonly handle: StorageHandle

  /** Shape of each dimension (e.g. [3, 224, 224] for a batch of images). */
  readonly shape: number[]

  /** Stride (in elements) to advance along each dimension. */
  readonly strides: number[]

  /** Element data type. */
  readonly dtype: DType

  /** Byte offset into the underlying storage where this view begins. */
  readonly offset: number

  /** Total number of scalar elements in this view. */
  readonly numElements: number

  /** Total byte extent required (numElements * dtype byte size). */
  readonly byteSize: number

  /**
   * Validate shape/strides/dtype/storage consistency.
   *
   * Checks:
   * - shape and strides have equal length
   * - numElements equals the product of shape dimensions
   * - byteSize equals numElements * dtype byte size
   * - byteSize + offset <= handle.sizeBytes
   */
  validate(): boolean

  /**
   * Produce a zero-copy sub-view without duplicating storage.
   *
   * @param start — inclusive start index for each dimension.
   * @param end   — exclusive end index for each dimension.
   * @returns A new TensorView sharing the same StorageHandle.
   */
  slice(start: number[], end: number[]): TensorView

  /**
   * Force a copy of the view into a new owning StorageHandle and return a
   * materialization receipt alongside the new view.
   */
  materialize(): MaterializedTensor
}
