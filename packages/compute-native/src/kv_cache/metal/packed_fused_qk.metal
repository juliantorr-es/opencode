/*
 * Copyright 2025 TurboQuant MLX Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Baseline fused Q@K from packed storage (no pre-rotate).
 * Dequantizes K, runs inverse WHT butterfly in-threadgroup,
 * dots with Q, reduces. One dispatch per (head, position) pair.
 * Templated for float/half.
 */

#include <metal_stdlib>
using namespace metal;

template<typename T>
kernel void tq_packed_fused_qk(
    device const T* query         [[buffer(0)]],
    device const uint* packed     [[buffer(1)]],
    device const float* norms     [[buffer(2)]],
    device const float* centroids [[buffer(3)]],
    device const float* signs     [[buffer(4)]],
    device const float* scale     [[buffer(5)]],
    device const uint* dims       [[buffer(6)]],
    device T* out                 [[buffer(7)]],
    uint pos                      [[threadgroup_position_in_grid]],
    uint head                     [[threadgroup_position_in_grid.y]],
    uint elem                     [[thread_position_in_threadgroup]]
) {
    uint dim           = dims[0];
    uint seq_len       = dims[1];
    uint bits          = dims[3];
    uint vals_per_word = dims[4];
    uint packed_dim    = dims[5];
    uint bit_mask      = (1u << bits) - 1u;

    uint kv_base = head * seq_len * packed_dim + pos * packed_dim;
    uint word_idx    = elem / vals_per_word;
    uint pos_in_word = elem % vals_per_word;
    uint word = packed[kv_base + word_idx];
    uint idx  = (word >> (pos_in_word * bits)) & bit_mask;

    T val = centroids[idx] * scale[0];

    // Parallel WHT butterfly
    threadgroup T shared[256];
    shared[elem] = val;
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

    // Dequant value + dot product with query
    T dequant_val = shared[elem] * scale[0] * signs[elem] * norms[head * seq_len + pos];
    T partial = dequant_val * query[head * dim + elem];

    // Parallel reduction
    shared[elem] = partial;
    threadgroup_barrier(mem_flags::mem_threadgroup);

    for (uint stride = dim / 2; stride > 0; stride >>= 1) {
        if (elem < stride) {
            shared[elem] += shared[elem + stride];
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }

    if (elem == 0) {
        out[head * seq_len + pos] = shared[0];
    }
}
