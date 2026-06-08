import type { AllocationClass, StorageBackend } from "./types.js"

/** A reference to an allocated memory region owned by a compute backend. */
export interface StorageHandle {
  /** Globally-unique identifier for this handle. */
  readonly id: string

  /** Allocation class governing lifecycle and placement. */
  readonly allocationClass: AllocationClass

  /** Backend that owns the physical storage. */
  readonly backend: StorageBackend

  /** Total size of the allocated region in bytes. */
  readonly sizeBytes: number

  /** True if this handle is a borrowed view into another handle's storage. */
  readonly isView: boolean

  /** If isView is true, the id of the parent owning handle. */
  readonly parentId?: string

  /** ISO-8601 timestamp of handle creation. */
  readonly createdAt: string

  /** Release the underlying storage. No-op for views (the owning handle owns the lifetime). */
  release(): void
}

// ── Internal state ──────────────────────────────────────────────────────────

let nextHandleId = 0

interface HandleEntry {
  handle: StorageHandle
  refCount: number
  released: boolean
}

const handleRegistry = new Map<string, HandleEntry>()

// ── Factory ─────────────────────────────────────────────────────────────────

/** Options for creating a new storage handle. */
export interface CreateStorageHandleOptions {
  allocationClass: AllocationClass
  backend: StorageBackend
  sizeBytes: number
  isView?: boolean
  parentId?: string
}

/**
 * Create a new owning StorageHandle. The handle is registered for validation
 * and reference tracking.
 */
export function createStorageHandle(
  options: CreateStorageHandleOptions,
): StorageHandle {
  const id = `handle_${nextHandleId++}`
  const createdAt = new Date().toISOString()
  const isView = options.isView ?? false
  const parentId = isView ? options.parentId : undefined

  let released = false

  const handle: StorageHandle = {
    id,
    allocationClass: options.allocationClass,
    backend: options.backend,
    sizeBytes: options.sizeBytes,
    isView,
    parentId,
    createdAt,
    release() {
      if (released) {
        throw new Error(
          `StorageHandle ${id}: double-free — handle already released`,
        )
      }
      released = true
      handleRegistry.delete(id)

      if (!isView) {
        // Owning handle: if there are view references still alive, leak a
        // warning since we're force-freeing.  In practice the caller should
        // ensure views are released first.
        decrementRefCount(id)
      }
      // View release is a no-op for the backend — the owning handle's
      // reference count was incremented on view creation and decremented
      // here.
    },
  }

  handleRegistry.set(id, { handle, refCount: 1, released: false })
  return handle
}

/**
 * Create a view handle that borrows the storage of an existing owning handle.
 * The parent's reference count is incremented so it stays alive while the view
 * exists.
 */
export function createViewHandle(
  parent: StorageHandle,
  options: { sizeBytes?: number; backend?: StorageBackend },
): StorageHandle {
  const parentEntry = handleRegistry.get(parent.id)
  if (!parentEntry || parentEntry.released) {
    throw new Error(
      `createViewHandle: parent handle ${parent.id} is not valid or has been released`,
    )
  }

  // Increment parent ref count to keep it alive.
  parentEntry.refCount++

  const handle = createStorageHandle({
    allocationClass: parent.allocationClass,
    backend: options.backend ?? parent.backend,
    sizeBytes: options.sizeBytes ?? parent.sizeBytes,
    isView: true,
    parentId: parent.id,
  })

  return handle
}

/**
 * Check whether a handle id is still alive (not released).
 */
export function isValidHandle(handleId: string): boolean {
  const entry = handleRegistry.get(handleId)
  return entry !== undefined && !entry.released
}

/**
 * Return the current reference count of a handle.  Returns 0 for unknown or
 * released handles.
 */
export function getHandleRefCount(handleId: string): number {
  const entry = handleRegistry.get(handleId)
  return entry && !entry.released ? entry.refCount : 0
}

/**
 * Release every handle in the registry.  Used during teardown.
 */
export function drainAllHandles(): void {
  for (const entry of handleRegistry.values()) {
    entry.released = true
  }
  handleRegistry.clear()
}

// ── Internals ───────────────────────────────────────────────────────────────

function decrementRefCount(handleId: string): void {
  const entry = handleRegistry.get(handleId)
  if (!entry) return
  entry.refCount = Math.max(0, entry.refCount - 1)
  if (entry.refCount === 0) {
    entry.released = true
    handleRegistry.delete(handleId)
  }
}
