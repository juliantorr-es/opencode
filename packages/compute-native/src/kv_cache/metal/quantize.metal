/*
 * Copyright 2025 TurboQuant MLX Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Fused quantize kernel: raw fp16 vector → packed uint32 + norm.
 * One threadgroup per vector (dim threads).
 * Replaces: upcast → norm → normalize → signs → WHT → centroid → pack.
 */

#include <metal_stdlib>
using namespace metal;

kernel void tq_fused_quantize(
    device const half* inp          [[buffer(0)]],
    device const float* signs       [[buffer(1)]],
    device const float* boundaries  [[buffer(2)]],
    device const uint* dims         [[buffer(3)]],
    device uint* packed_out         [[buffer(4)]],
    device float* norms_out         [[buffer(5)]],
    uint pos                        [[threadgroup_position_in_grid]],
    uint elem                       [[thread_position_in_threadgroup]]
) {
    uint dim           = dims[0];
    uint bits          = dims[1];
    uint vals_per_word = dims[2];
    uint packed_dim    = dims[3];
    uint n_centroids   = dims[4];

    // Load input vector into shared memory as float32
    threadgroup float shared[256];
    shared[elem] = (float)inp[pos * dim + elem];
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // Step 1: Compute L2 norm via parallel reduction
    threadgroup float norm_shared[256];
    norm_shared[elem] = shared[elem] * shared[elem];
    threadgroup_barrier(mem_flags::mem_threadgroup);

    for (uint stride = dim / 2; stride > 0; stride >>= 1) {
        if (elem < stride) {
            norm_shared[elem] += norm_shared[elem + stride];
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }
    float vec_norm = sqrt(norm_shared[0]);
    float safe_norm = max(vec_norm, 1e-8f);

    // Step 2: Normalize
    shared[elem] = shared[elem] / safe_norm;
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // Step 3: Apply signs (randomized Hadamard = signs * WHT)
    shared[elem] = shared[elem] * signs[elem];
    threadgroup_barrier(mem_flags::mem_threadgroup);

    // Step 4: WHT butterfly
    uint h = 1;
    while (h < dim) {
        uint block  = elem / (2 * h);
        uint offset = elem % (2 * h);
        if (offset < h) {
            uint j = block * 2 * h + offset;
            float a = shared[j];
            float b = shared[j + h];
            shared[j]     = a + b;
            shared[j + h] = a - b;
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
        h *= 2;
    }

    // Step 5: Nearest centroid (count boundaries exceeded)
    float scaled = shared[elem];
    uint idx = 0;
    for (uint b = 0; b < n_centroids - 1; b++) {
        if (scaled > boundaries[b]) {
            idx++;
        }
    }

    // Step 6: Pack indices
    threadgroup uint idx_shared[256];
    idx_shared[elem] = idx;
    threadgroup_barrier(mem_flags::mem_threadgroup);

    uint word_idx    = elem / vals_per_word;
    uint pos_in_word = elem % vals_per_word;

    if (pos_in_word == 0 && word_idx < packed_dim) {
        uint word = 0;
        for (uint i = 0; i < vals_per_word && (word_idx * vals_per_word + i) < dim; i++) {
            word |= (idx_shared[word_idx * vals_per_word + i] & ((1u << bits) - 1u)) << (i * bits);
        }
        packed_out[pos * packed_dim + word_idx] = word;
    }

    // Thread 0 writes the norm
    if (elem == 0) {
        norms_out[pos] = vec_norm;
    }
}
