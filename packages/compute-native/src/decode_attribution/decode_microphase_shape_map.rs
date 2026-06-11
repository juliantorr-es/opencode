//! DECODE-MICROPHASE-SUITE-0001: Decode microphase shape map.
//!
//! Maps symbolic dimension names to concrete values for the decode_small_v1
//! and decode_medium_v1 semantic shape profiles. These are NOT the same as
//! the Tier 0/1 shape profiles (small=1x4, medium=1x128) — decode profiles
//! use hidden_dim/num_heads/head_dim dimensions that are meaningful for
//! transformer decode phases.
//!
//! Profiles:
//! - decode_small_v1:   hidden_dim=16, num_heads=2, head_dim=8, past_kv_len=8,  intermediate_dim=32, vocab_dim=64
//! - decode_medium_v1:  hidden_dim=64, num_heads=4, head_dim=16, past_kv_len=32, intermediate_dim=128, vocab_dim=256

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DecodeShapeBinding {
    pub profile_name: &'static str,
    pub batch: u32,
    pub query_tokens: u32,
    pub hidden_dim: u32,
    pub num_heads: u32,
    pub head_dim: u32,
    pub past_kv_len: u32,
    pub kv_len: u32,
    pub intermediate_dim: u32,
    pub vocab_dim: u32,
}

impl DecodeShapeBinding {
    /// QKV combined projection weight: [hidden_dim, 3 * hidden_dim]
    pub fn qkv_weight_shape(&self) -> (u32, u32) {
        (self.hidden_dim, 3 * self.hidden_dim)
    }

    /// Attention output projection weight: [hidden_dim, hidden_dim]
    pub fn attn_out_weight_shape(&self) -> (u32, u32) {
        (self.hidden_dim, self.hidden_dim)
    }

    /// Gate projection weight: [hidden_dim, intermediate_dim]
    pub fn gate_weight_shape(&self) -> (u32, u32) {
        (self.hidden_dim, self.intermediate_dim)
    }

    /// Up projection weight: [hidden_dim, intermediate_dim]
    pub fn up_weight_shape(&self) -> (u32, u32) {
        (self.hidden_dim, self.intermediate_dim)
    }

    /// Down projection weight: [intermediate_dim, hidden_dim]
    pub fn down_weight_shape(&self) -> (u32, u32) {
        (self.intermediate_dim, self.hidden_dim)
    }

    /// LM head weight: [hidden_dim, vocab_dim]
    pub fn lm_head_weight_shape(&self) -> (u32, u32) {
        (self.hidden_dim, self.vocab_dim)
    }

    /// Single token input state: [batch, hidden_dim]
    pub fn hidden_shape(&self) -> (u32, u32) {
        (self.batch, self.hidden_dim)
    }
}

/// decode_small_v1: hidden_dim=16, num_heads=2, head_dim=8, past_kv_len=8
pub const DECODE_SMALL_V1: DecodeShapeBinding = DecodeShapeBinding {
    profile_name: "decode_small_v1",
    batch: 1,
    query_tokens: 1,
    hidden_dim: 16,
    num_heads: 2,
    head_dim: 8,
    past_kv_len: 8,
    kv_len: 8,
    intermediate_dim: 32,
    vocab_dim: 64,
};

/// decode_medium_v1: hidden_dim=64, num_heads=4, head_dim=16, past_kv_len=32
pub const DECODE_MEDIUM_V1: DecodeShapeBinding = DecodeShapeBinding {
    profile_name: "decode_medium_v1",
    batch: 1,
    query_tokens: 1,
    hidden_dim: 64,
    num_heads: 4,
    head_dim: 16,
    past_kv_len: 32,
    kv_len: 32,
    intermediate_dim: 128,
    vocab_dim: 256,
};

pub const ALL_DECODE_SHAPES: &[DecodeShapeBinding] = &[DECODE_SMALL_V1, DECODE_MEDIUM_V1];

/// Look up a decode shape binding by semantic profile name.
pub fn decode_shape_for(semantic_profile_name: &str) -> Option<&'static DecodeShapeBinding> {
    ALL_DECODE_SHAPES.iter().find(|p| p.profile_name == semantic_profile_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_small_v1_shape() {
        let s = &DECODE_SMALL_V1;
        assert_eq!(s.hidden_dim, 16);
        assert_eq!(s.qkv_weight_shape(), (16, 48));
        assert_eq!(s.lm_head_weight_shape(), (16, 64));
    }

    #[test]
    fn decode_medium_v1_shape() {
        let s = &DECODE_MEDIUM_V1;
        assert_eq!(s.hidden_dim, 64);
        assert_eq!(s.gate_weight_shape(), (64, 128));
        assert_eq!(s.down_weight_shape(), (128, 64));
    }

    #[test]
    fn all_decode_shapes_have_unique_names() {
        let mut names: Vec<&str> = ALL_DECODE_SHAPES.iter().map(|s| s.profile_name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), ALL_DECODE_SHAPES.len(), "profile names must be unique");
    }

    #[test]
    fn decode_shape_for_found() {
        assert!(decode_shape_for("decode_small_v1").is_some());
        assert!(decode_shape_for("decode_medium_v1").is_some());
        assert!(decode_shape_for("unknown").is_none());
    }
}
