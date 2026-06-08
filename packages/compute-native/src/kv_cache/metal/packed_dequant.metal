/*
 * Copyright 2025 TurboQuant MLX Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Templated dequant from packed uint32 storage.
 * Template parameter T controls output type (float/half).
 * One threadgroup per vector, dim threads cooperating on butterfly.
 */

#include <metal_stdlib>
using namespace metal;

template<typename T>
kernel void tq_packed_dequant(
    device const uint* packed     [[buffer(0)]],
    device const float* norms     [[buffer(1)]],
    device const float* centroids [[buffer(2)]],
    device const float* signs     [[buffer(3)]],
    device const float* scale     [[buffer(4)]],
    device const uint* dims       [[buffer(5)]],
    device T* out                 [[buffer(6)]],
    uint pos                      [[threadgroup_position_in_grid]],
    uint elem                     [[thread_position_in_threadgroup]]
) {
    uint dim           = dims[0];
    uint bits          = dims[1];
    uint vals_per_word = dims[2];
    uint packed_dim    = dims[3];
    uint bit_mask      = (1u << bits) - 1u;

    uint word_idx    = elem / vals_per_word;
    uint pos_in_word = elem % vals_per_word;
    uint word = packed[pos * packed_dim + word_idx];
    uint idx = (word >> (pos_in_word * bits)) & bit_mask;

    T val = centroids[idx] * scale[0];

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

    T result = shared[elem] * scale[0] * signs[elem] * norms[pos];
    out[pos * dim + elem] = result;
}
