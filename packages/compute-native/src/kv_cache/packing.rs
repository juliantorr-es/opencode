//! Bit-packing for TurboQuant indices.
//!
//! Packs multiple small-bit indices into uint32 words:
//! - 3-bit: 10 values per uint32 (30/32 bits used)
//! - 4-bit:  8 values per uint32
//!
//! For 3-bit with dim=128: 13 uint32s per vector (52 bytes)
//! vs 128 bytes (uint8) vs 256 bytes (fp16) = 4.9x compression.
//!
//! Attribution: packing logic derived from arozanov/turboquant-mlx (Apache 2.0).

/// Number of values per uint32 word for each bit width.
pub const VALS_PER_WORD_3BIT: usize = 10;
pub const VALS_PER_WORD_4BIT: usize = 8;
pub const BIT_MASK_3BIT: u32 = 0x7;
pub const BIT_MASK_4BIT: u32 = 0xF;

/// Number of uint32 words needed to pack `dim` values at `bits` each.
pub fn packed_dim(dim: usize, bits: u32) -> usize {
    let vpw = vals_per_word(bits);
    (dim + vpw - 1) / vpw
}

/// Pack dim uint8 indices at `bits` each into packed_dim uint32 words.
pub fn pack_indices(indices: &[u8], dim: usize, bits: u32) -> Vec<u32> {
    let vpw = vals_per_word(bits);
    let n_words = packed_dim(dim, bits);
    let n_vecs = indices.len() / dim;
    let mut packed = vec![0u32; n_vecs * n_words];

    for v in 0..n_vecs {
        for w in 0..n_words {
            let mut word = 0u32;
            for i in 0..vpw {
                let elem_idx = v * dim + w * vpw + i;
                if elem_idx >= indices.len() {
                    break;
                }
                let val = (indices[elem_idx] as u32) & ((1u32 << bits) - 1);
                word |= val << (i * bits as usize) as u32;
            }
            packed[v * n_words + w] = word;
        }
    }
    packed
}

/// Unpack packed_dim uint32 words back to dim uint8 indices.
pub fn unpack_indices(packed: &[u32], dim: usize, bits: u32) -> Vec<u8> {
    let vpw = vals_per_word(bits);
    let n_words = packed_dim(dim, bits);
    let mask: u32 = (1u32 << bits) - 1;
    let n_vecs = packed.len() / n_words;
    let mut indices = vec![0u8; n_vecs * dim];

    for v in 0..n_vecs {
        for w in 0..n_words {
            for i in 0..vpw {
                let elem_idx = v * dim + w * vpw + i;
                if elem_idx >= indices.len() {
                    break;
                }
                let val = (packed[v * n_words + w] >> (i * bits as usize) as u32) & mask;
                indices[elem_idx] = val as u8;
            }
        }
    }
    indices
}

fn vals_per_word(bits: u32) -> usize {
    match bits {
        1 => 32,
        2 => 16,
        3 => 10,
        4 => 8,
        _ => panic!("Unsupported bit width: {}", bits),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pack_unpack_3bit_roundtrip() {
        let dim = 128;
        let indices: Vec<u8> = (0..dim).map(|i| (i % 8) as u8).collect();
        let packed = pack_indices(&indices, dim, 3);
        assert_eq!(packed.len(), packed_dim(dim, 3));
        let unpacked = unpack_indices(&packed, dim, 3);
        assert_eq!(unpacked, indices);
    }

    #[test]
    fn test_pack_unpack_multi_vector() {
        let dim = 128;
        let n_vecs = 4;
        let indices: Vec<u8> = (0..n_vecs * dim).map(|i| (i % 8) as u8).collect();
        let packed = pack_indices(&indices, dim, 3);
        assert_eq!(packed.len(), n_vecs * packed_dim(dim, 3));
        let unpacked = unpack_indices(&packed, dim, 3);
        assert_eq!(unpacked, indices);
    }

    #[test]
    fn test_packed_dim() {
        assert_eq!(packed_dim(128, 3), 13);
        assert_eq!(packed_dim(120, 3), 12);
        assert_eq!(packed_dim(128, 4), 16);
    }
}
