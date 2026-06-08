//! Per-layer KV cache for Gemma 4 hybrid attention.
//!
//! Supports sliding-window eviction on sliding layers and concatenation on
//! global layers. Each layer holds its own (keys, values) pair.

use mlx_rs::{ops, Array};
use mlx_rs::ops::indexing::IndexOp;
use mlx_rs::error::Result as MlxResult;

/// Per-layer KV cache for Gemma 4's hybrid local/global attention schedule.
///
/// Sliding layers evict the oldest positions once `seq_len >= capacity`,
/// keeping only the last `capacity` positions. Global layers grow unboundedly
/// via concatenation.
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
    /// Cached keys array, shape [n_tokens, n_kv_heads, head_dim].
    k_cache: Option<Array>,
    /// Cached values array, shape [n_tokens, n_kv_heads, head_dim].
    v_cache: Option<Array>,
    /// Current number of cached positions.
    pub seq_len: u32,
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
        }
    }

    /// Append new K and V arrays to this layer's cache.
    ///
    /// - `keys`, `values`: shape `[n_tokens, n_kv_heads, head_dim]`
    ///
    /// For **sliding layers**: if the resulting sequence length exceeds
    /// `capacity`, slices to keep only the last `capacity` positions along
    /// the sequence dimension (axis 0).
    ///
    /// For **global layers**: concatenates with the existing cache along
    /// the sequence dimension.
    pub fn append(&mut self, keys: Array, values: Array) -> MlxResult<()> {
        let incoming_len = keys.shape()[0] as u32;

        match self.k_cache.take() {
            None => {
                self.k_cache = Some(keys);
                self.v_cache = Some(values);
                self.seq_len = incoming_len;
            }
            Some(cached_k) => {
                let cached_v = self.v_cache.take().expect("v_cache must be present when k_cache is");
                let total = cached_k.shape()[0] as u32 + incoming_len;

                if self.is_sliding && total > self.capacity {
                    // Sliding eviction: keep only the last `capacity` positions.
                    let trim = (total - self.capacity) as i32;
                    let new_k = ops::concatenate_axis(
                        &[&cached_k.index((trim.., .., ..)), &keys],
                        0,
                    )?;
                    let new_v = ops::concatenate_axis(
                        &[&cached_v.index((trim.., .., ..)), &values],
                        0,
                    )?;
                    self.k_cache = Some(new_k);
                    self.v_cache = Some(new_v);
                } else {
                    // Global layer or within window — concat.
                    let new_k = ops::concatenate_axis(&[&cached_k, &keys], 0)?;
                    let new_v = ops::concatenate_axis(&[&cached_v, &values], 0)?;
                    self.k_cache = Some(new_k);
                    self.v_cache = Some(new_v);
                }
                self.seq_len = self
                    .k_cache
                    .as_ref()
                    .map(|k| k.shape()[0] as u32)
                    .unwrap_or(0);
            }
        }
        Ok(())
    }

    /// Returns a cloned copy of the full cached K and V arrays.
    ///
    /// Returns `None` if no cached data exists for this layer.
    pub fn read_window(&self) -> Option<(Array, Array)> {
        match (&self.k_cache, &self.v_cache) {
            (Some(k), Some(v)) => Some((k.clone(), v.clone())),
            _ => None,
        }
    }

    /// Total bytes consumed by this cache (K + V, f32).
    pub fn total_bytes(&self) -> u64 {
        if self.seq_len == 0 {
            return 0;
        }
        let elements = self.seq_len as u64 * self.n_kv_heads as u64 * self.head_dim as u64;
        elements * 4 * 2 // f32 (4 bytes) × K + V (2 arrays)
    }

    /// Reset the cache, dropping all stored tensors.
    pub fn clear(&mut self) {
        self.k_cache = None;
        self.v_cache = None;
        self.seq_len = 0;
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
        // Shape: [seq, 8, 256], fill with ones for verification.
        let shape = &[seq as i32, 8, 256];
        let k = ops::ones::<f32>(shape).unwrap();
        let v = ops::ones::<f32>(shape).unwrap();
        (k, v)
    }

    #[test]
    fn test_new_cache_empty() {
        let cache = make_cache(false);
        assert_eq!(cache.seq_len, 0);
        assert!(cache.read_window().is_none());
        assert_eq!(cache.total_bytes(), 0);
    }

    #[test]
    fn test_append_global_layer() {
        let mut cache = make_cache(false);
        let (k, v) = make_kv(10);
        cache.append(k, v).unwrap();
        assert_eq!(cache.seq_len, 10);

        let (k2, v2) = make_kv(5);
        cache.append(k2, v2).unwrap();
        assert_eq!(cache.seq_len, 15);

        let (k_cached, _) = cache.read_window().unwrap();
        assert_eq!(k_cached.shape()[0], 15);
    }

    #[test]
    fn test_append_sliding_within_window() {
        let mut cache = make_cache(true);
        let (k, v) = make_kv(3);
        cache.append(k, v).unwrap();
        assert_eq!(cache.seq_len, 3);
    }

    #[test]
    fn test_append_sliding_evicts() {
        let mut cache = make_cache(true);
        let (k, v) = make_kv(3);
        cache.append(k, v).unwrap();
        let (k2, v2) = make_kv(3);
        cache.append(k2, v2).unwrap();
        // Window = 4, 6 total → only 4 kept.
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
    }

    #[test]
    fn test_total_bytes() {
        let mut cache = make_cache(false);
        assert_eq!(cache.total_bytes(), 0);
        let (k, v) = make_kv(5);
        cache.append(k, v).unwrap();
        // 5 * 8 * 256 * 4 * 2 = 81920
        assert_eq!(cache.total_bytes(), 81920);
    }
}
