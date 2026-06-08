//! Bounded arena pool with generation tracking for SharedTensorArena v1.
//!
//! Keyed by arena profile (IOSurfaceFp16ContiguousV1) and logical shape.
//! Pools are bounded by global byte budget and per-session arena budget.
//!
//! Phase 3: Arena Pool + Structured Errors.

use std::collections::HashMap;
use std::sync::Mutex;
use crate::arena::Arena;
use crate::arena_lifecycle::LifecycleState;

/// Pool key: profile + shape.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PoolKey {
    pub profile: &'static str, // "IOSurfaceFp16ContiguousV1"
    pub dim0: u32,
    pub dim1: u32,
}

/// A pooled arena with generation tracking.
struct PoolEntry {
    arena: Arena,
    generation: u64,
    state: LifecycleState,
}

/// Bounded, thread-safe pool of IOSurface-backed FP16 arenas.
///
/// Arenas are grouped by `PoolKey` (profile + logical shape). The pool enforces
/// a global byte budget (`max_total_bytes`) and a per-key capacity limit
/// (`max_arenas_per_key`). Acquisition reuses `Free` entries; when none are
/// available a new arena is allocated. Release returns the arena to the cache
/// or drops it when the per-key limit is reached.
pub struct ArenaPool {
    entries: Mutex<HashMap<PoolKey, Vec<PoolEntry>>>,
    max_total_bytes: usize,
    current_bytes: Mutex<usize>,
    max_arenas_per_key: usize,
}

impl ArenaPool {
    /// Create a new empty pool.
    ///
    /// - `max_total_bytes`: global byte budget for all pooled arenas.
    /// - `max_arenas_per_key`: max arenas cached per shape/profile combination.
    pub fn new(max_total_bytes: usize, max_arenas_per_key: usize) -> Self {
        ArenaPool {
            entries: Mutex::new(HashMap::new()),
            max_total_bytes,
            current_bytes: Mutex::new(0),
            max_arenas_per_key,
        }
    }

    /// Acquire an arena from the pool or allocate a new one.
    ///
    /// Returns `(arena, was_pooled)` — `was_pooled` is `true` when a previously
    /// released entry was reused, `false` when a fresh arena was allocated.
    pub fn acquire(
        &self,
        profile: &'static str,
        dim0: u32,
        dim1: u32,
    ) -> Result<(Arena, bool), String> {
        if profile != "IOSurfaceFp16ContiguousV1" {
            return Err(format!("unsupported pool profile: {}", profile));
        }

        let key = PoolKey { profile, dim0, dim1 };

        // Try to find a Free entry.
        {
            let mut entries = self.entries.lock().unwrap();
            if let Some(vec) = entries.get_mut(&key) {
                if let Some(idx) = vec.iter().position(|e| e.state == LifecycleState::Free) {
                    let entry = vec.remove(idx);
                    return Ok((entry.arena, true));
                }
            }
        }

        // No Free entry — allocate a new arena.
        let arena = Arena::new(dim0, dim1, mlx_rs::Dtype::Float16)?;
        let byte_size = arena.byte_len();

        // Check global byte budget.
        let mut current = self.current_bytes.lock().unwrap();
        if *current + byte_size > self.max_total_bytes {
            // Arena already allocated — Drop handles IOSurface teardown.
            drop(arena);
            return Err(format!(
                "arena pool budget exceeded: {} + {} > {}",
                *current, byte_size, self.max_total_bytes
            ));
        }
        *current += byte_size;

        Ok((arena, false))
    }

    /// Release an arena back to the pool.
    ///
    /// If the per-key cache is full the arena is dropped (IOSurface freed) and
    /// the byte budget is decremented. Otherwise the arena is stored as a
    /// `Free` entry for later reuse.
    pub fn release(
        &self,
        profile: &'static str,
        dim0: u32,
        dim1: u32,
        arena: Arena,
    ) -> Result<(), String> {
        let key = PoolKey { profile, dim0, dim1 };
        let byte_size = arena.byte_len();

        let mut entries = self.entries.lock().unwrap();
        let vec = entries.entry(key).or_insert_with(Vec::new);

        if vec.len() >= self.max_arenas_per_key {
            // Pool full for this shape — drop the arena, release memory.
            drop(arena);
            let mut current = self.current_bytes.lock().unwrap();
            *current = current.saturating_sub(byte_size);
            return Ok(());
        }

        vec.push(PoolEntry {
            arena,
            generation: 0, // placeholder; generation tracking TBD
            state: LifecycleState::Free,
        });

        Ok(())
    }

    /// Return current pool statistics.
    pub fn stats(&self) -> PoolStats {
        let entries = self.entries.lock().unwrap();
        let total: usize = entries.values().map(|v| v.len()).sum();
        let free: usize = entries
            .values()
            .map(|v| v.iter().filter(|e| e.state == LifecycleState::Free).count())
            .sum();
        let current = *self.current_bytes.lock().unwrap();
        PoolStats {
            total_entries: total,
            free_entries: free,
            current_bytes: current,
            max_bytes: self.max_total_bytes,
        }
    }
}

/// Snapshot of arena pool metrics.
#[derive(Debug, Clone)]
pub struct PoolStats {
    pub total_entries: usize,
    pub free_entries: usize,
    pub current_bytes: usize,
    pub max_bytes: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pool_acquire_release() {
        let pool = ArenaPool::new(1024 * 1024, 4);
        let (arena, was_pooled) = pool
            .acquire("IOSurfaceFp16ContiguousV1", 1, 4)
            .expect("acquire");
        assert!(!was_pooled);
        assert!(arena.io_surface_id() > 0);
        pool.release("IOSurfaceFp16ContiguousV1", 1, 4, arena)
            .expect("release");
    }

    #[test]
    fn test_pool_reuse() {
        let pool = ArenaPool::new(1024 * 1024, 4);
        let (arena1, was1) = pool
            .acquire("IOSurfaceFp16ContiguousV1", 1, 4)
            .expect("a1");
        assert!(!was1);
        let id1 = arena1.io_surface_id();
        pool.release("IOSurfaceFp16ContiguousV1", 1, 4, arena1)
            .expect("r1");

        let (arena2, was2) = pool
            .acquire("IOSurfaceFp16ContiguousV1", 1, 4)
            .expect("a2");
        assert!(was2, "should have reused pooled arena");
        assert_eq!(
            arena2.io_surface_id(),
            id1,
            "same IOSurface ID on reuse"
        );
        pool.release("IOSurfaceFp16ContiguousV1", 1, 4, arena2)
            .expect("r2");
    }

    #[test]
    fn test_pool_budget() {
        // Tiny budget — should fail after one allocation.
        let pool = ArenaPool::new(8, 4);
        let (arena1, _) = pool
            .acquire("IOSurfaceFp16ContiguousV1", 1, 4)
            .expect("a1");
        let result = pool.acquire("IOSurfaceFp16ContiguousV1", 1, 4);
        assert!(result.is_err(), "should exceed budget");
        pool.release("IOSurfaceFp16ContiguousV1", 1, 4, arena1)
            .expect("r1");
    }

    #[test]
    fn test_pool_max_per_key() {
        let pool = ArenaPool::new(1024 * 1024, 2);
        let (a1, _) = pool
            .acquire("IOSurfaceFp16ContiguousV1", 1, 4)
            .expect("a1");
        let (a2, _) = pool
            .acquire("IOSurfaceFp16ContiguousV1", 1, 4)
            .expect("a2");
        let (a3, _) = pool
            .acquire("IOSurfaceFp16ContiguousV1", 1, 4)
            .expect("a3");
        // Release all — only 2 should be cached (max_per_key=2).
        pool.release("IOSurfaceFp16ContiguousV1", 1, 4, a1)
            .expect("r1");
        pool.release("IOSurfaceFp16ContiguousV1", 1, 4, a2)
            .expect("r2");
        pool.release("IOSurfaceFp16ContiguousV1", 1, 4, a3)
            .expect("r3");
        let stats = pool.stats();
        assert!(
            stats.total_entries <= 2,
            "pool should cap at max_per_key"
        );
    }
}
