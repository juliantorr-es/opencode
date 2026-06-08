/*
 * Copyright 2025 TurboQuant MLX Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sparse V attention with butterfly-pulled-out optimization.
 *
 * Key insight (WHT linearity):
 *   sum_pos w[pos] * WHT(c_pos) = WHT(sum_pos w[pos] * c_pos)
 *
 * Phase 1: accumulate S[elem] = sum_pos w[pos] * norm[pos] * centroids[idx]
 *          across positions — per-thread, NO barriers.
 * Phase 2: ONE threadgroup-wide butterfly on S. 
 * Phase 3: signs * scale applied once per element.
 *
 * On seq_len=8K, dim=128: 8000 × log(128) ≈ 56000 barriers → 7 barriers.
 * Positions with weight < threshold are skipped entirely.
 *
 * GQA-aware: V indexed by kv_head = q_head / n_rep.
 */

#include <metal_stdlib>
using namespace metal;

template<typename T>
kernel void tq_sparse_v_matvec(
    device const T* weights        [[buffer(0)]],
    device const uint* v_packed    [[buffer(1)]],
    device const float* v_norms    [[buffer(2)]],
    device const float* centroids  [[buffer(3)]],
    device const float* signs      [[buffer(4)]],
    device const float* scale      [[buffer(5)]],
    device const float* threshold  [[buffer(6)]],
    device const uint* dims        [[buffer(7)]],
    device T* out                  [[buffer(8)]],
    uint head                      [[threadgroup_position_in_grid]],
    uint elem                      [[thread_position_in_threadgroup]]
) {
    uint dim           = dims[0];
    uint seq_len       = dims[1];
    uint bits          = dims[2];
    uint vals_per_word = dims[3];
    uint packed_dim    = dims[4];
    uint n_rep         = dims[5];
    uint bit_mask      = (1u << bits) - 1u;
    uint kv_head       = head / n_rep;

    // Phase 1: per-thread accumulate across positions — no barriers.
    T s = (T)0;
    uint v_base = kv_head * seq_len * packed_dim;
    uint word_idx = elem / vals_per_word;
    uint pos_in_word = elem % vals_per_word;
    uint shift = pos_in_word * bits;
    for (uint pos = 0; pos < seq_len; pos++) {
        T w = weights[head * seq_len + pos];
        if (w < threshold[0]) continue;
        uint word = v_packed[v_base + pos * packed_dim + word_idx];
        uint idx = (word >> shift) & bit_mask;
        s += w * v_norms[kv_head * seq_len + pos] * centroids[idx];
    }

    // Phase 2: one threadgroup-wide butterfly on S.
    threadgroup T shared[256];
    shared[elem] = s;
    threadgroup_barrier(mem_flags::mem_threadgroup);

    uint h = 1;
    while (h < dim) {
        uint block  = elem / (2 * h);
        uint offset = elem % (2 * h);
        if (offset < h) {
            uint j = block * 2 * h + offset;
            T a = shared[j];
            T b = shared[j + h];
            shared[j]     = a + b;
            shared[j + h] = a - b;
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
        h *= 2;
    }

    out[head * dim + elem] = shared[elem] * signs[elem] * scale[0];
}
