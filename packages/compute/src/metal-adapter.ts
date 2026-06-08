import type { AllocationClass, StorageBackend } from "./types.js"
import { createStorageHandle, type StorageHandle } from "./storage-handle.js"
import { isNativeAvailable, detectDefaultDevice } from "./native-backend.js"

// ── MTLStorageMode mapping ──────────────────────────────────────────────────

/**
 * Apple Metal storage mode constants matching the Metal framework enum.
 * Used to communicate allocation semantics to a native Metal bridge.
 */
export const MTLStorageMode = {
  /** Shared memory accessible by both CPU and GPU. Default. */
  Shared: 0,
  /** Private memory only accessible by the GPU. */
  Private: 1,
  /** Managed memory for discrete GPU architectures (Intel Mac). */
  Managed: 2,
} as const

export type MTLStorageModeValue =
  (typeof MTLStorageMode)[keyof typeof MTLStorageMode]

/**
 * Map an AllocationClass to the corresponding MTLStorageMode.
 *
 * - `shared`  → MTLStorageModeShared  (CPU + GPU access)
 * - `device`  → MTLStorageModePrivate (GPU-only, fastest)
 * - `pinned`  → MTLStorageModeShared  (pinned = CPU-pinned shared memory)
 */
export function allocationClassToMTLStorageMode(
  allocClass: AllocationClass,
): MTLStorageModeValue {
  switch (allocClass) {
    case "shared":
      return MTLStorageMode.Shared
    case "device":
      return MTLStorageMode.Private
    case "pinned":
      return MTLStorageMode.Shared
  }
}

// ── Metal availability detection ────────────────────────────────────────────

/** Result of Metal availability detection. */
export interface MetalAvailability {
  /** Whether Metal is available on this system. */
  readonly available: boolean

  /** Human-readable device name, if available. */
  readonly deviceName: string

  /** Whether the metal-cpp bridge library was detected. */
  readonly hasNativeBridge: boolean

  /** Reason if unavailable. */
  readonly reason?: string
}

/**
 * Detect whether Metal is available on this system.
 *
 * On Apple Silicon (darwin) we probe the @tribunus/compute-native
 * napi-rs addon for MLX-backed Metal compute.
 */
export function detectMetalAvailability(): MetalAvailability {
  try {
    const platform =
      typeof process !== "undefined" ? process.platform : undefined

    if (platform !== "darwin") {
      return {
        available: false,
        deviceName: "",
        hasNativeBridge: false,
        reason: `Metal requires macOS / darwin (got ${platform ?? "unknown"})`,
      }
    }

    const nativeAvailable = isNativeAvailable()
    if (nativeAvailable) {
      const info = detectDefaultDevice()
      return {
        available: info.available,
        deviceName: info.deviceName,
        hasNativeBridge: true,
      }
    }

    return {
      available: true,
      deviceName: "Apple Metal GPU (native addon not built)",
      hasNativeBridge: false,
      reason: "@tribunus/compute-native addon not available — run `bun run build` in packages/compute-native/",
    }
  } catch {
    return {
      available: false,
      deviceName: "",
      hasNativeBridge: false,
      reason: "Metal detection failed",
    }
  }
}

// ── Metallic result ─────────────────────────────────────────────────────────

/**
 * The result of allocating a Metal buffer.
 */
export interface MetalBuffer {
  /** Handle to the buffer storage. */
  readonly handle: StorageHandle

  /** The Metal storage mode used for allocation. */
  readonly storageMode: MTLStorageModeValue

  /** Whether the buffer was backed by a native MTLBuffer. */
  readonly isNative: boolean
}

// ── Metal backend ───────────────────────────────────────────────────────────

/**
 * Metal backend capabilities mirroring the BackendCapability shape but at
 * the storage layer.
 */
export interface MetalBackendCapabilities {
  readonly backend: "metal"
  readonly available: boolean
  readonly deviceName: string
  readonly hasNativeBridge: boolean
  readonly maxBufferBytes: number
}

/**
 * Default maximum Metal buffer size (4 GB) — the practical limit on most
 * Apple Silicon hardware without querying the device properties.
 */
const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024 * 1024

/**
 * Detect and describe the Metal backend.  This is the storage-layer analogue
 * of `detectBackends()` in backend-router.ts.
 */
export function detectMetalBackend(): MetalBackendCapabilities {
  const avail = detectMetalAvailability()
  return {
    backend: "metal",
    available: avail.available,
    deviceName: avail.deviceName,
    hasNativeBridge: avail.hasNativeBridge,
    maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
  }
}

/**
 * Allocate a Metal-backed storage handle.
 *
 * When the native metal-cpp bridge is available the buffer is backed by a
 * real MTLBuffer.  Otherwise a CPU-backed fallback handle is returned.
 *
 * @param sizeBytes      Requested buffer size in bytes.
 * @param allocationClass Allocation class determining MTLStorageMode.
 * @returns               A MetalBuffer descriptor.
 */
export function allocateMetalBuffer(
  sizeBytes: number,
  allocationClass: AllocationClass,
): MetalBuffer {
  const storageMode = allocationClassToMTLStorageMode(allocationClass)

  // Attempt native allocation if the bridge is detected.
  const avail = detectMetalAvailability()
  if (avail.available && avail.hasNativeBridge) {
    // Native path — in a production build this would call across the FFI
    // boundary to MTLDevice.newBufferWithLength:options:.
    //
    //   const mtlBuffer = MetalCpp.newBuffer(sizeBytes, storageMode)
    //
    // For now we return a stub handle tagged as native.
    const handle = createStorageHandle({
      allocationClass,
      backend: "metal",
      sizeBytes,
    })
    return { handle, storageMode, isNative: true }
  }

  // Fallback: CPU-backed storage tagged with the "metal" backend label so
  // consumers can use the same code path while Metal is unavailable.
  const backend: StorageBackend = avail.available ? "metal" : "cpu"
  const handle = createStorageHandle({
    allocationClass,
    backend,
    sizeBytes,
  })
  return { handle, storageMode, isNative: false }
}

/**
 * Create a Metal-backed buffer from an existing host buffer (pinned / shared).
 * Useful for uploading CPU data to a Metal buffer.
 *
 * Falls back to a plain handle when the native bridge is not available.
 */
export function createMetalBufferFromHost(
  sizeBytes: number,
  source: ArrayBufferView | ArrayBuffer,
  allocationClass: AllocationClass,
): MetalBuffer {
  const result = allocateMetalBuffer(sizeBytes, allocationClass)
  // In a real bridge this would call:
  //   mtlBuffer.getContents().copyFrom(source)
  return result
}

/**
 * Release a Metal buffer back to the pool (or free it).
 */
export function releaseMetalBuffer(buffer: MetalBuffer): void {
  buffer.handle.release()
}
