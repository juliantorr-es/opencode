/*
 * Copyright 2025 TurboQuant MLX Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pre-rotated Q @ K, GQA-aware.
 * Grid.y addresses query heads; K indexed by kv_head = head / n_rep.
 * No per-K butterfly, no per-K signs. Uses simd_sum for fast reduction.
 *
 * scores[q_head, pos] = (norms[kv_head, pos] / sqrt(d)) *
 *                       <Q_rot[q_head], centroids[K_idx[kv_head, pos]]>
 */

#include <metal_stdlib>
using namespace metal;

template<typename T>
kernel void tq_prerot_fused_qk(
    device const T* q_rot         [[buffer(0)]],
    device const uint* packed     [[buffer(1)]],
    device const float* norms     [[buffer(2)]],
    device const float* centroids [[buffer(3)]],
    device const float* scale     [[buffer(4)]],
    device const uint* dims       [[buffer(5)]],
    device T* out                 [[buffer(6)]],
    uint pos                      [[threadgroup_position_in_grid]],
    uint head                     [[threadgroup_position_in_grid.y]],
    uint elem                     [[thread_position_in_threadgroup]]
) {
    uint dim           = dims[0];
    uint seq_len       = dims[1];
    uint bits          = dims[2];
    uint vals_per_word = dims[3];
    uint packed_dim    = dims[4];
    uint n_rep         = dims[5];
    uint bit_mask      = (1u << bits) - 1u;
    uint kv_head       = head / n_rep;

    // Unpack one codebook index for (kv_head, pos, elem)
    uint kv_base = kv_head * seq_len * packed_dim + pos * packed_dim;
    uint word_idx    = elem / vals_per_word;
    uint pos_in_word = elem % vals_per_word;
    uint word = packed[kv_base + word_idx];
    uint idx  = (word >> (pos_in_word * bits)) & bit_mask;

    // Partial product with the pre-rotated query — no butterfly here
    T partial = centroids[idx] * q_rot[head * dim + elem];

    // SIMD reduction: simd_sum over 32 lanes, then barrier-stitch SIMD-groups
    T simd_part = simd_sum(partial);
    threadgroup T simd_sums[8];
    uint simd_id = elem / 32;
    uint lane_id = elem % 32;
    if (lane_id == 0) simd_sums[simd_id] = simd_part;
    threadgroup_barrier(mem_flags::mem_threadgroup);

    if (elem == 0) {
        T total = (T)0;
        uint n_simds = dim / 32;
        for (uint i = 0; i < n_simds; i++) total += simd_sums[i];
        out[head * seq_len + pos] = total * norms[kv_head * seq_len + pos] * scale[0];
    }
}
