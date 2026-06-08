/*
 * Copyright 2025 TurboQuant MLX Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pre-rotate query: signs * Q → raw WHT butterfly (no 1/sqrt(d)).
 * One threadgroup per head, dim threads cooperating on butterfly.
 * Called once per decode step — O(heads * d log d), not per KV position.
 */

#include <metal_stdlib>
using namespace metal;

template<typename T>
kernel void tq_prerotate_query(
    device const T* q_in          [[buffer(0)]],
    device const float* signs     [[buffer(1)]],
    device const uint* dims       [[buffer(2)]],
    device T* q_out               [[buffer(3)]],
    uint head                     [[threadgroup_position_in_grid]],
    uint elem                     [[thread_position_in_threadgroup]]
) {
    uint dim = dims[0];

    threadgroup T shared[256];
    shared[elem] = q_in[head * dim + elem] * signs[elem];
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

    q_out[head * dim + elem] = shared[elem];
}
