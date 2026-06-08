import type { AllocationClass, StorageBackend } from "./types.js"
import type { StorageHandle } from "./storage-handle.js"
import { createStorageHandle } from "./storage-handle.js"

/** Statistics snapshot for a buffer pool. */
export interface BufferPoolStats {
  /** Number of buffers currently acquired (in use). */
  readonly allocated: number

  /** Number of buffers currently sitting in the pool (available). */
  readonly pooled: number

  /** Maximum number of buffers ever in-flight at once. */
  readonly peak: number

  /** Total bytes allocated across all buffers currently in the pool. */
  readonly totalPooledBytes: number
}

/** A buffer pool that manages the lifecycle of StorageHandles for a specific
 *  allocation class and backend.
 *
 *  Acquired handles are loaned to callers; released handles are returned to
 *  the pool for reuse rather than deallocated.
 */
export interface BufferPool {
  /** Allocation class of buffers managed by this pool. */
  readonly allocationClass: AllocationClass

  /** Backend of buffers managed by this pool. */
  readonly backend: StorageBackend

  /** Maximum number of pooled (idle) buffers retained before draining. */
  readonly maxPoolSize: number

  /**
   * Acquire a buffer of at least `sizeBytes` from the pool, or allocate a
   * new one if no suitable pooled buffer exists.
   */
  acquire(sizeBytes: number): StorageHandle

  /**
   * Return a handle to the pool. The handle becomes pooled and available
   * for future acquire() calls. If the pool is at capacity the handle is
   * released immediately.
   */
  release(handle: StorageHandle): void

  /** Current pool statistics. */
  stats(): BufferPoolStats

  /** Release every pooled buffer, draining the idle queue. */
  drain(): void
}

// ── Size buckets ────────────────────────────────────────────────────────────

const SIZE_BUCKETS = [
  256,
  1_024, // 1 KB
  4_096, // 4 KB
  16_384, // 16 KB
  65_536, // 64 KB
  262_144, // 256 KB
  1_048_576, // 1 MB
  4_194_304, // 4 MB
  16_777_216, // 16 MB
  67_108_864, // 64 MB
] as const

function bucketForSize(sizeBytes: number): number {
  for (const bucket of SIZE_BUCKETS) {
    if (sizeBytes <= bucket) return bucket
  }
  // Anything larger than the biggest bucket rounds up to the next aligned KB
  return Math.ceil(sizeBytes / 1024) * 1024
}

// ── Pooled handle wrapper ───────────────────────────────────────────────────

/** Internal wrapper that tracks when the handle entered the free list. */
interface PoolEntry {
  handle: StorageHandle
  enqueuedAt: number // timestamp for LRU ordering
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Options for creating a BufferPool. */
export interface CreateBufferPoolOptions {
  allocationClass: AllocationClass
  backend: StorageBackend
  maxPoolSize?: number
}

/**
 * Create a new BufferPool for a given allocation class and backend.
 *
 * Buffers are grouped into size buckets ([256B … 64MB]).  The pool uses FIFO
 * ordering within each bucket: the oldest idle buffer is evicted first when
 * the pool exceeds `maxPoolSize`.
 */
export function createBufferPool(options: CreateBufferPoolOptions): BufferPool {
  const { allocationClass, backend } = options
  const maxPoolSize = options.maxPoolSize ?? 64

  // Free list per size bucket, ordered oldest-first (head of array = LRU).
  const freeLists = new Map<number, PoolEntry[]>()

  let allocatedCount = 0
  let pooledCount = 0
  let peakConcurrent = 0

  function totalPooledBytes(): number {
    let total = 0
    for (const entries of freeLists.values()) {
      for (const entry of entries) {
        total += entry.handle.sizeBytes
      }
    }
    return total
  }

  function stats(): BufferPoolStats {
    return {
      allocated: allocatedCount,
      pooled: pooledCount,
      peak: peakConcurrent,
      totalPooledBytes: totalPooledBytes(),
    }
  }

  /**
   * Evict one entry from the least-recently-used bucket if the pool is at
   * capacity.  Eviction pops the oldest entry (head of the free list) across
   * all buckets.
   */
  function evictOne(): void {
    if (pooledCount < maxPoolSize) return

    let oldestBucket: number | undefined
    let oldestEntry: PoolEntry | undefined

    for (const [bucket, entries] of freeLists) {
      if (entries.length === 0) continue
      const candidate = entries[0] // head is oldest
      if (!oldestEntry || candidate.enqueuedAt < oldestEntry.enqueuedAt) {
        oldestEntry = candidate
        oldestBucket = bucket
      }
    }

    if (oldestBucket === undefined || oldestEntry === undefined) return

    const list = freeLists.get(oldestBucket)!
    list.shift() // remove oldest
    if (list.length === 0) freeLists.delete(oldestBucket)
    pooledCount--
    oldestEntry.handle.release()
  }

  function acquire(sizeBytes: number): StorageHandle {
    const bucket = bucketForSize(sizeBytes)
    const list = freeLists.get(bucket)

    if (list && list.length > 0) {
      const entry = list.pop()! // pop from tail = most recently released
      if (list.length === 0) freeLists.delete(bucket)
      pooledCount--
      allocatedCount++
      if (allocatedCount > peakConcurrent) {
        peakConcurrent = allocatedCount
      }
      return entry.handle
    }

    // No pooled buffer available — allocate fresh.
    const handle = createStorageHandle({
      allocationClass,
      backend,
      sizeBytes: bucket,
    })
    allocatedCount++
    if (allocatedCount > peakConcurrent) {
      peakConcurrent = allocatedCount
    }
    return handle
  }

  function release(handle: StorageHandle): void {
    // Clean up any already-released handle that slipped through.
    if (handle.sizeBytes === 0) {
      allocatedCount = Math.max(0, allocatedCount - 1)
      return
    }

    const bucket = bucketForSize(handle.sizeBytes)

    // If the pool is at capacity evict the oldest buffer first.
    evictOne()

    // Insert at the tail of the free list (most recently used).
    let list = freeLists.get(bucket)
    if (!list) {
      list = []
      freeLists.set(bucket, list)
    }
    list.push({ handle, enqueuedAt: Date.now() })
    pooledCount++
    allocatedCount = Math.max(0, allocatedCount - 1)
  }

  function drain(): void {
    for (const [bucket, entries] of freeLists) {
      for (const entry of entries) {
        entry.handle.release()
      }
    }
    freeLists.clear()
    pooledCount = 0
    allocatedCount = 0
  }

  return {
    allocationClass,
    backend,
    maxPoolSize,
    acquire,
    release,
    stats,
    drain,
  }
}
