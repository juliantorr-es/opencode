//! Per-layer KV cache for Gemma 4 hybrid attention.
//!
//! Supports sliding-window eviction on sliding layers and concatenation on
//! global layers. Each layer holds its own (keys, values) pair.
//!
//! Sliding layers use a ring buffer: a preallocated [capacity, n_kv_heads, head_dim]
//! array that circularly overwrites the oldest entries. Global layers grow
//! unboundedly via concatenation.
//!
//! Commit/rollback: append() writes to a staging region tracked by total_appended;
//! commit_step() advances committed_len; rollback() discards uncommitted data.
//! read_window() returns all data including uncommitted, so the attention
//! kernel can read the full cache immediately after append.

use mlx_rs::{ops, Array};
use mlx_rs::ops::indexing::IndexOp;
use mlx_rs::ops::indexing::IndexMutOp;
use mlx_rs::error::Result as MlxResult;

/// Per-layer KV cache for Gemma 4's hybrid local/global attention schedule.
///
/// Sliding layers use a ring buffer that overwrites the oldest entries once
/// the window exceeds capacity. Global layers grow via concatenation.
#[derive(Debug)]
pub struct KvCache {
    /// Number of KV heads for this layer.
    pub n_kv_heads: u32,
    /// Head dimension for this layer.
    pub head_dim: u32,
    /// Maximum number of positions this cache can hold (sliding window or
    /// global max).
    pub capacity: u32,
    /// Whether this layer uses sliding-window eviction.
    pub is_sliding: bool,

    // ── Cached arrays ──────────────────────────────────────────────────
    /// Cached keys. For sliding layers: None (ring buffer used instead).
    /// For global layers: concatenated KV along axis 0.
    k_cache: Option<Array>,
    /// Cached values.
    v_cache: Option<Array>,

    /// Current number of cached positions visible for attention
    /// (= min(total_appended, capacity) for sliding, total_appended for global).
    pub seq_len: u32,

    // ── Ring buffer (sliding layers only) ─────────────────────────────
    /// Preallocated ring buffer for keys, shape [capacity, n_kv_heads, head_dim].
    preallocated_k: Option<Array>,
    /// Preallocated ring buffer for values.
    preallocated_v: Option<Array>,

    // ── Logical position tracking ──────────────────────────────────────
    /// Total tokens ever appended to this cache.
    pub total_appended: u32,
    /// Absolute position of cache[0] in the overall token sequence.
    /// For sliding layers, this advances as old entries are evicted.
    /// For global layers, it stays 0.
    pub logical_start: u32,
    /// Next write index in the ring buffer for sliding layers, or total
    /// tokens stored for global layers.
    pub physical_write_pos: u32,

    // ── Commit/rollback tracking ──────────────────────────────────────
    /// Number of committed tokens (visible to attention after commit_step).
    pub committed_len: u32,
    /// Snapshot of global-layer arrays before the last uncommitted append,
    /// used to restore on rollback.
    rollback_k: Option<Array>,
    /// Snapshot of global-layer values before the last uncommitted append.
    rollback_v: Option<Array>,

    // ── Byte accounting ───────────────────────────────────────────────
    /// Number of evictions that have occurred.
    pub evictions_count: u64,
    /// Bytes copied during operations.
    pub copy_bytes: u64,
}

impl KvCache {
    /// Create a new empty per-layer KV cache.
    ///
    /// `capacity` is the maximum number of positions stored (sliding window
    /// for sliding layers, `max_position_embeddings` for global layers).
    /// `is_sliding` enables sliding-window eviction.
    pub fn new(capacity: u32, n_kv_heads: u32, head_dim: u32, is_sliding: bool) -> Self {
        Self {
            n_kv_heads,
            head_dim,
            capacity,
            is_sliding,
            k_cache: None,
            v_cache: None,
            seq_len: 0,
            preallocated_k: None,
            preallocated_v: None,
            total_appended: 0,
            logical_start: 0,
            physical_write_pos: 0,
            committed_len: 0,
            rollback_k: None,
            rollback_v: None,
            evictions_count: 0,
            copy_bytes: 0,
        }
    }

    // ── Append ─────────────────────────────────────────────────────────

    /// Append new K and V arrays to this layer's cache.
    ///
    /// - `keys`, `values`: shape `[n_tokens, n_kv_heads, head_dim]`
    ///
    /// **Sliding layers**: ring buffer write into preallocated storage,
    /// overwriting oldest entries on wrap. On first append, if
    /// `n_tokens > capacity`, the input is trimmed to the last `capacity`
    /// tokens.
    ///
    /// **Global layers**: concatenate along the sequence dimension.
    ///
    /// The append is uncommitted until `commit_step()` is called. If the
    /// caller needs to roll back, `rollback()` restores the pre-append state.
    pub fn append(&mut self, keys: Array, values: Array) -> MlxResult<()> {
        let incoming_len = keys.shape()[0] as u32;

        if self.k_cache.is_none() && self.v_cache.is_none()
            && self.preallocated_k.is_none() && self.preallocated_v.is_none()
        {
            self.first_append(keys, values, incoming_len)
        } else if self.is_sliding {
            self.append_sliding(keys, values, incoming_len)
        } else {
            self.append_global(keys, values, incoming_len)
        }
    }

    /// First-ever append: initialise storage.
    fn first_append(&mut self, keys: Array, values: Array, incoming_len: u32) -> MlxResult<()> {
        if self.is_sliding {
            // Trim first append if it exceeds capacity.
            let (k_trimmed, v_trimmed, actual_n) = if incoming_len > self.capacity {
                let excess = incoming_len - self.capacity;
                let k = keys.index((excess as i32.., .., ..));
                let v = values.index((excess as i32.., .., ..));
                self.evictions_count = excess as u64;
                (k, v, self.capacity)
            } else {
                (keys, values, incoming_len)
            };

            if actual_n > self.capacity {
                return Err(mlx_rs::error::Exception::custom(
                    "first append still exceeds capacity after trimming",
                ));
            }

            // Preallocate ring buffer.
            let shape = &[self.capacity as i32, self.n_kv_heads as i32, self.head_dim as i32];
            let mut pre_k = ops::zeros::<f32>(shape)?;
            let mut pre_v = ops::zeros::<f32>(shape)?;

            pre_k.index_mut((0..actual_n as i32, .., ..), &k_trimmed);
            pre_v.index_mut((0..actual_n as i32, .., ..), &v_trimmed);

            self.preallocated_k = Some(pre_k);
            self.preallocated_v = Some(pre_v);
            self.total_appended = actual_n;
            self.seq_len = actual_n;
            self.logical_start = 0;
            self.physical_write_pos = actual_n % self.capacity;
            self.committed_len = actual_n;
        } else {
            self.k_cache = Some(keys);
            self.v_cache = Some(values);
            self.total_appended = incoming_len;
            self.seq_len = incoming_len;
            self.logical_start = 0;
            self.physical_write_pos = incoming_len;
            self.committed_len = incoming_len;
        }
        Ok(())
    }

    /// Append to a sliding layer using the ring buffer.
    fn append_sliding(
        &mut self,
        keys: Array,
        values: Array,
        incoming_len: u32,
    ) -> MlxResult<()> {
        let pre_k = self.preallocated_k.as_mut()
            .expect("preallocated_k must exist for sliding append");
        let pre_v = self.preallocated_v.as_mut()
            .expect("preallocated_v must exist for sliding append");

        let cap = self.capacity as i32;
        let write_pos = self.physical_write_pos as i32;
        let n_tok = incoming_len as i32;
        let end_wrap = write_pos + n_tok;

        if end_wrap <= cap {
            // Contiguous write: no wrap.
            pre_k.index_mut((write_pos..end_wrap, .., ..), &keys);
            pre_v.index_mut((write_pos..end_wrap, .., ..), &values);
        } else {
            // Wrapping write.
            let first_seg = cap - write_pos;
            let second_seg = n_tok - first_seg;

            let k_first = keys.index((0..first_seg, .., ..));
            let v_first = values.index((0..first_seg, .., ..));
            pre_k.index_mut((write_pos..cap, .., ..), &k_first);
            pre_v.index_mut((write_pos..cap, .., ..), &v_first);

            let k_second = keys.index((first_seg.., .., ..));
            let v_second = values.index((first_seg.., .., ..));
            pre_k.index_mut((0..second_seg, .., ..), &k_second);
            pre_v.index_mut((0..second_seg, .., ..), &v_second);
        }

        self.physical_write_pos = (self.physical_write_pos + incoming_len) % self.capacity;
        self.total_appended += incoming_len;
        self.seq_len = std::cmp::min(self.total_appended, self.capacity);

        // Update logical_start: position of the first valid entry.
        if self.total_appended > self.capacity {
            self.logical_start = self.total_appended - self.capacity;
        }

        // Track evictions count.
        if self.total_appended > self.capacity {
            let evicted = self.total_appended - self.capacity;
            self.evictions_count = evicted as u64;
        }

        // Save pre-append state for rollback (the old total_appended allows us
        // to know how many tokens were valid before this append).
        self.rollback_k = None;
        self.rollback_v = None;

        Ok(())
    }

    /// Append to a global layer by concatenating along the sequence axis.
    fn append_global(
        &mut self,
        keys: Array,
        values: Array,
        incoming_len: u32,
    ) -> MlxResult<()> {
        // Save pre-append arrays for rollback.
        let old_k = self.k_cache.as_ref().map(|k| k.clone());
        let old_v = self.v_cache.as_ref().map(|v| v.clone());

        let cached_k = self.k_cache.take().expect("k_cache must be present");
        let cached_v = self.v_cache.take().expect("v_cache must be present");

        let new_k = ops::concatenate_axis(&[&cached_k, &keys], 0)?;
        let new_v = ops::concatenate_axis(&[&cached_v, &values], 0)?;

        let copy_k = cached_k.size() as u64 * 4;
        let copy_v = cached_v.size() as u64 * 4;
        self.copy_bytes += copy_k + copy_v;

        self.k_cache = Some(new_k);
        self.v_cache = Some(new_v);
        self.total_appended += incoming_len;
        self.seq_len += incoming_len;
        self.physical_write_pos += incoming_len;

        self.rollback_k = old_k;
        self.rollback_v = old_v;

        Ok(())
    }

    // ── Commit / rollback ──────────────────────────────────────────────

    /// Commit the current append, making it the new committed baseline.
    ///
    /// After successful eval, call this to accept the KV data written by
    /// the last `append()`.
    pub fn commit_step(&mut self) {
        self.committed_len = self.uncommitted_len();
        self.rollback_k = None;
        self.rollback_v = None;
    }

    /// Roll back the last uncommitted append, restoring the cache to its
    /// pre-append state.
    ///
    /// For sliding layers: truncates the logical view (seq_len, total_appended)
    /// back to the committed position. Ring buffer data is left in place and
    /// will be overwritten on the next append.
    ///
    /// For global layers: restores the saved pre-append arrays.
    pub fn rollback(&mut self) {
        if self.total_appended == self.committed_len && self.seq_len == self.committed_len {
            return;
        }

        if self.is_sliding {
            // Restore the pre-append state from the committed boundary.
            if self.committed_len == 0 {
                // Fully reset sliding layer.
                self.preallocated_k = None;
                self.preallocated_v = None;
                self.total_appended = 0;
                self.seq_len = 0;
                self.logical_start = 0;
                self.physical_write_pos = 0;
            } else {
                self.total_appended = self.committed_len;
                self.seq_len = std::cmp::min(self.committed_len, self.capacity);

                if self.total_appended > self.capacity {
                    self.logical_start = self.total_appended - self.capacity;
                } else {
                    self.logical_start = 0;
                }

                // physical_write_pos must reflect the write position after
                // the committed data was written. We can derive this:
                // After committed_len tokens, the next write pos is committed_len % capacity.
                self.physical_write_pos = self.committed_len % self.capacity;
            }
        } else {
            // Restore global-layer arrays from snapshots.
            self.k_cache = self.rollback_k.take();
            self.v_cache = self.rollback_v.take();

            self.total_appended = self.committed_len;
            self.seq_len = self.committed_len;
            self.physical_write_pos = self.committed_len;
        }

        self.rollback_k = None;
        self.rollback_v = None;
    }

    /// Number of uncommitted tokens (total_appended - committed_len).
    fn uncommitted_len(&self) -> u32 {
        self.total_appended
    }

    // ── Read ───────────────────────────────────────────────────────────

    /// Returns a cloned copy of the cached K and V arrays for the full cache
    /// (including uncommitted data). The attention kernel reads from this
    /// after every append.
    ///
    /// For sliding layers: reconstructs a contiguous view from the ring buffer.
    ///
    /// Returns `None` if no data exists.
    pub fn read_window(&self) -> Option<(Array, Array)> {
        if self.is_sliding {
            self.read_window_sliding()
        } else {
            match (&self.k_cache, &self.v_cache) {
                (Some(k), Some(v)) => Some((k.clone(), v.clone())),
                _ => None,
            }
        }
    }

    /// Reconstruct a contiguous committed window from the ring buffer.
    fn read_window_sliding(&self) -> Option<(Array, Array)> {
        let pre_k = self.preallocated_k.as_ref()?;
        let pre_v = self.preallocated_v.as_ref()?;

        if self.seq_len == 0 {
            return None;
        }

        let cap = self.capacity as i32;
        let n_to_read = self.seq_len as i32;

        // When total_appended < capacity, valid data starts at position 0.
        // When total_appended >= capacity, valid data starts at physical_write_pos
        // (the oldest surviving entry).
        let read_start = if self.total_appended >= self.capacity {
            self.physical_write_pos as i32
        } else {
            0i32
        };

        let end_wrap = read_start + n_to_read;
        if end_wrap <= cap {
            // Contiguous segment.
            let k = pre_k.index((read_start..end_wrap, .., ..));
            let v = pre_v.index((read_start..end_wrap, .., ..));
            Some((k, v))
        } else {
            // Wrapping segment: two concatenated slices.
            let first_seg = cap - read_start;
            let second_seg = n_to_read - first_seg;

            let k1 = pre_k.index((read_start..cap, .., ..));
            let v1 = pre_v.index((read_start..cap, .., ..));
            let k2 = pre_k.index((0..second_seg, .., ..));
            let v2 = pre_v.index((0..second_seg, .., ..));

            let k = ops::concatenate_axis(&[&k1, &k2], 0).ok()?;
            let v = ops::concatenate_axis(&[&v1, &v2], 0).ok()?;
            Some((k, v))
        }
    }

    // ── Byte accounting ────────────────────────────────────────────────

    /// Total bytes of preallocated arrays.
    ///
    /// For sliding layers: full ring buffer allocation (capacity × heads ×
    /// head_dim × 4 bytes × 2 arrays). For global layers: current cache size.
    pub fn allocated_bytes(&self) -> u64 {
        if self.is_sliding {
            if self.preallocated_k.is_none() {
                return 0;
            }
            let elements = self.capacity as u64
                * self.n_kv_heads as u64
                * self.head_dim as u64;
            elements * 4 * 2 // f32 × K+V
        } else {
            if self.seq_len == 0 {
                return 0;
            }
            let elements = self.seq_len as u64
                * self.n_kv_heads as u64
                * self.head_dim as u64;
            elements * 4 * 2
        }
    }

    /// Bytes for committed positions.
    pub fn committed_bytes(&self) -> u64 {
        if self.committed_len == 0 {
            return 0;
        }
        let len = std::cmp::min(self.committed_len, self.capacity);
        let elements = len as u64 * self.n_kv_heads as u64 * self.head_dim as u64;
        elements * 4 * 2
    }

    /// Bytes copied from staging to committed area.
    pub fn copy_bytes(&self) -> u64 {
        self.copy_bytes
    }

    /// Total bytes consumed by this cache (K + V, f32).
    #[deprecated(note = "use allocated_bytes() or committed_bytes() instead")]
    pub fn total_bytes(&self) -> u64 {
        if self.seq_len == 0 {
            return 0;
        }
        let elements = self.seq_len as u64 * self.n_kv_heads as u64 * self.head_dim as u64;
        elements * 4 * 2
    }

    // ── Receipt ────────────────────────────────────────────────────────

    /// Return a JSON string with the cache receipt.
    pub fn receipt_json(&self) -> String {
        let is_sliding = if self.is_sliding { "true" } else { "false" };
        format!(
            r#"{{"logical_start":{},"logical_length":{},"capacity":{},"physical_write_pos":{},"allocated_bytes":{},"committed_bytes":{},"evictions_count":{},"is_sliding":{}}}"#,
            self.logical_start,
            self.committed_len,
            self.capacity,
            self.physical_write_pos,
            self.allocated_bytes(),
            self.committed_bytes(),
            self.evictions_count,
            is_sliding,
        )
    }

    // ── Reset ──────────────────────────────────────────────────────────

    /// Reset the cache, dropping all stored tensors.
    pub fn clear(&mut self) {
        self.k_cache = None;
        self.v_cache = None;
        self.preallocated_k = None;
        self.preallocated_v = None;
        self.rollback_k = None;
        self.rollback_v = None;
        self.seq_len = 0;
        self.total_appended = 0;
        self.logical_start = 0;
        self.physical_write_pos = 0;
        self.committed_len = 0;
        self.evictions_count = 0;
        self.copy_bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mlx_rs::ops;

    fn make_cache(is_sliding: bool) -> KvCache {
        KvCache::new(4, 8, 256, is_sliding)
    }

    fn make_kv(seq: u32) -> (Array, Array) {
        let shape = &[seq as i32, 8, 256];
        let k = ops::ones::<f32>(shape).unwrap();
        let v = ops::ones::<f32>(shape).unwrap();
        (k, v)
    }

    fn make_kv_filled(seq: u32, val: f32) -> (Array, Array) {
        let shape = &[seq as i32, 8, 256];
        let fill = Array::from_slice(&[val], &[1]);
        let k = ops::full::<f32>(shape, &fill).unwrap();
        let v = ops::full::<f32>(shape, &fill).unwrap();
        (k, v)
    }

    // ── Original tests (adapted) ───────────────────────────────────────

    #[test]
    fn test_new_cache_empty() {
        let cache = make_cache(false);
        assert_eq!(cache.seq_len, 0);
        assert!(cache.read_window().is_none());
        assert_eq!(cache.allocated_bytes(), 0);
        assert_eq!(cache.logical_start, 0);
        assert_eq!(cache.physical_write_pos, 0);
        assert_eq!(cache.committed_len, 0);
        assert_eq!(cache.allocated_bytes(), 0);
    }

    #[test]
    fn test_append_global_layer() {
        let mut cache = make_cache(false);
        let (k, v) = make_kv(10);
        cache.append(k, v).unwrap();
        assert_eq!(cache.seq_len, 10);
        assert_eq!(cache.committed_len, 10);

        let (k2, v2) = make_kv(5);
        cache.append(k2, v2).unwrap();
        assert_eq!(cache.seq_len, 15);
        assert_eq!(cache.committed_len, 10); // uncommitted

        cache.commit_step();
        assert_eq!(cache.committed_len, 15);

        let (k_cached, _) = cache.read_window().unwrap();
        assert_eq!(k_cached.shape()[0], 15);
    }

    #[test]
    fn test_append_sliding_within_window() {
        let mut cache = make_cache(true);
        let (k, v) = make_kv(3);
        cache.append(k, v).unwrap();
        assert_eq!(cache.seq_len, 3);
        assert_eq!(cache.committed_len, 3);
        assert_eq!(cache.read_window().unwrap().0.shape()[0], 3);
    }

    #[test]
    fn test_append_sliding_evicts() {
        let mut cache = make_cache(true);
        let (k, v) = make_kv(3);
        cache.append(k, v).unwrap();
        let (k2, v2) = make_kv(3);
        cache.append(k2, v2).unwrap();
        // Window = 4, 6 total => only 4 kept.
        assert_eq!(cache.seq_len, 4);
        assert_eq!(cache.read_window().unwrap().0.shape()[0], 4);
    }

    #[test]
    fn test_read_window_returns_clones() {
        let mut cache = make_cache(false);
        let (k, v) = make_kv(5);
        cache.append(k, v).unwrap();

        let (k1, _) = cache.read_window().unwrap();
        let (k2, _) = cache.read_window().unwrap();
        assert_eq!(k1.shape()[0], 5);
        assert_eq!(k2.shape()[0], 5);
    }

    #[test]
    fn test_clear() {
        let mut cache = make_cache(false);
        let (k, v) = make_kv(10);
        cache.append(k, v).unwrap();
        cache.clear();
        assert!(cache.read_window().is_none());
        assert_eq!(cache.seq_len, 0);
        assert_eq!(cache.logical_start, 0);
        assert_eq!(cache.physical_write_pos, 0);
    }

    #[test]
    fn test_allocated_bytes() {
        let mut cache = make_cache(false);
        assert_eq!(cache.allocated_bytes(), 0);
        let (k, v) = make_kv(5);
        cache.append(k, v).unwrap();
        // 5 * 8 * 256 * 4 * 2 = 81920
        assert_eq!(cache.allocated_bytes(), 81920);
    }

    // ── New tests ──────────────────────────────────────────────────────

    #[test]
    fn test_logical_positions() {
        let mut cache = make_cache(true);
        assert_eq!(cache.logical_start, 0);
        assert_eq!(cache.physical_write_pos, 0);

        let (k, v) = make_kv(2);
        cache.append(k, v).unwrap();
        assert_eq!(cache.logical_start, 0);
        assert_eq!(cache.physical_write_pos, 2);

        let (k2, v2) = make_kv(2);
        cache.append(k2, v2).unwrap();
        // Wrapped: 4 % 4 = 0
        assert_eq!(cache.physical_write_pos, 0);
        // Still within capacity, logical_start = 0
        assert_eq!(cache.logical_start, 0);

        let (k3, v3) = make_kv(1);
        cache.append(k3, v3).unwrap();
        // Now total=5 > capacity=4 → logical_start = 5 - 4 = 1
        assert_eq!(cache.logical_start, 1);
        assert_eq!(cache.physical_write_pos, 1);
        assert_eq!(cache.seq_len, 4);
    }

    #[test]
    fn test_ring_buffer_eviction() {
        let mut cache = make_cache(true);
        assert_eq!(cache.allocated_bytes(), 0);

        // Append 3, then 3 more (total 6 > cap 4 → wraps).
        let (k, v) = make_kv_filled(3, 1.0);
        cache.append(k, v).unwrap();

        let (k2, v2) = make_kv_filled(3, 2.0);
        cache.append(k2, v2).unwrap();

        assert_eq!(cache.seq_len, 4);

        // read_window should return 4 tokens (last 4 of 6).
        let (k_out, _) = cache.read_window().unwrap();
        assert_eq!(k_out.shape()[0], 4);

        // Verify evictions count.
        assert_eq!(cache.evictions_count, 2);

        // Add more tokens and verify further eviction.
        let (k3, v3) = make_kv_filled(2, 3.0);
        cache.append(k3, v3).unwrap();
        assert_eq!(cache.evictions_count, 4); // 8 total - 4 cap = 4 evicted
        assert_eq!(cache.seq_len, 4);
    }

    #[test]
    fn test_first_append_trimming() {
        let mut cache = make_cache(true);
        assert_eq!(cache.capacity, 4);

        // First append with 6 tokens (> capacity of 4).
        let (k, v) = make_kv(6);
        cache.append(k, v).unwrap();

        // Should be trimmed to capacity.
        assert_eq!(cache.seq_len, 4);
        assert_eq!(cache.committed_len, 4);

        let (k_out, _) = cache.read_window().unwrap();
        assert_eq!(k_out.shape()[0], 4);
    }

    #[test]
    fn test_large_first_append_sliding() {
        // First append with exactly capacity tokens — no trimming.
        let mut cache = make_cache(true);
        let (k, v) = make_kv(4);
        cache.append(k, v).unwrap();
        assert_eq!(cache.seq_len, 4);

        // First append with more than capacity — trimmed.
        let mut cache2 = make_cache(true);
        let (k2, v2) = make_kv(10);
        cache2.append(k2, v2).unwrap();
        assert_eq!(cache2.seq_len, 4);
        assert_eq!(cache2.evictions_count, 6);
    }

    #[test]
    fn test_commit_rollback_sliding() {
        let mut cache = make_cache(true);
        assert_eq!(cache.committed_len, 0);

        // First append: auto-committed.
        let (k, v) = make_kv(2);
        cache.append(k, v).unwrap();
        assert_eq!(cache.committed_len, 2);
        assert_eq!(cache.total_appended, 2);

        // Second append: uncommitted.
        let (k2, v2) = make_kv(2);
        cache.append(k2, v2).unwrap();
        assert_eq!(cache.committed_len, 2);
        assert_eq!(cache.total_appended, 4);
        assert_eq!(cache.seq_len, 4);

        // Rollback: restores to committed state.
        cache.rollback();
        assert_eq!(cache.committed_len, 2);
        assert_eq!(cache.total_appended, 2);
        assert_eq!(cache.seq_len, 2);

        // Append and commit.
        let (k3, v3) = make_kv(2);
        cache.append(k3, v3).unwrap();
        cache.commit_step();
        assert_eq!(cache.committed_len, 4);
        assert_eq!(cache.total_appended, 4);
    }

    #[test]
    fn test_commit_rollback_global() {
        let mut cache = make_cache(false);
        let (k, v) = make_kv(3);
        cache.append(k, v).unwrap();
        assert_eq!(cache.committed_len, 3);

        let (k2, v2) = make_kv(2);
        cache.append(k2, v2).unwrap();
        assert_eq!(cache.seq_len, 5);
        assert_eq!(cache.committed_len, 3);

        // Rollback should restore to committed state.
        cache.rollback();
        assert_eq!(cache.committed_len, 3);
        assert_eq!(cache.seq_len, 3);
        assert_eq!(cache.read_window().unwrap().0.shape()[0], 3);
    }

    #[test]
    fn test_receipt_json_sliding() {
        let mut cache = make_cache(true);
        let receipt = cache.receipt_json();
        assert!(receipt.contains(r#""is_sliding":true"#));
        assert!(receipt.contains(r#""capacity":4"#));
        assert!(receipt.contains(r#""logical_start":0"#));
        assert!(receipt.contains(r#""logical_length":0"#));

        let (k, v) = make_kv(3);
        cache.append(k, v).unwrap();
        let receipt = cache.receipt_json();
        assert!(receipt.contains(r#""logical_length":3"#));
    }

    #[test]
    fn test_receipt_json_global() {
        let cache = make_cache(false);
        let receipt = cache.receipt_json();
        assert!(receipt.contains(r#""is_sliding":false"#));
    }

    #[test]
    fn test_allocated_bytes_sliding() {
        let mut cache = make_cache(true);
        assert_eq!(cache.allocated_bytes(), 0);

        // After first append, ring buffer is allocated.
        let (k, v) = make_kv(2);
        cache.append(k, v).unwrap();
        // 4 * 8 * 256 * 4 * 2 = 65536
        assert_eq!(cache.allocated_bytes(), 65536);
    }

    #[test]
    fn test_committed_bytes() {
        let mut cache = make_cache(true);
        assert_eq!(cache.committed_bytes(), 0);

        let (k, v) = make_kv(2);
        cache.append(k, v).unwrap();
        // 2 * 8 * 256 * 4 * 2 = 32768
        assert_eq!(cache.committed_bytes(), 32768);

        // After rollback of subsequent uncommitted append.
        let (k2, v2) = make_kv(1);
        cache.append(k2, v2).unwrap();
        assert_eq!(cache.committed_bytes(), 32768); // unchanged
        cache.rollback();
        assert_eq!(cache.committed_bytes(), 32768); // back to committed
    }

    #[test]
    fn test_evictions_count() {
        let mut cache = make_cache(true);
        assert_eq!(cache.evictions_count, 0);

        let (k, v) = make_kv(3);
        cache.append(k, v).unwrap();
        assert_eq!(cache.evictions_count, 0);

        let (k2, v2) = make_kv(3);
        cache.append(k2, v2).unwrap();
        // 6 total - 4 cap = 2 evicted
        assert_eq!(cache.evictions_count, 2);

        let (k3, v3) = make_kv(3);
        cache.append(k3, v3).unwrap();
        // 9 total - 4 cap = 5 evicted
        assert_eq!(cache.evictions_count, 5);
    }
}
