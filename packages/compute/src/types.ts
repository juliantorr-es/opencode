/** Allocation class for a storage handle — determines lifecycle and placement semantics. */
export type AllocationClass = "shared" | "device" | "pinned"

/** Compute backend that owns the physical memory. */
export type StorageBackend = "metal" | "cpu" | "cuda" | "vulkan"

/** Element data type for tensor views. */
export type DType = "float32" | "float16" | "bfloat16" | "int32" | "int8" | "uint8"

/** Byte size of each DType variant. */
export const DTypeSizes: Record<DType, number> = {
  float32: 4,
  float16: 2,
  bfloat16: 2,
  int32: 4,
  int8: 1,
  uint8: 1,
}
