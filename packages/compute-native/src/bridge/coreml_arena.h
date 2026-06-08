// Shared type: TribunusArenaInfo
// Used by both coreml_arena.mm and coreml_exec.mm

#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int32_t width;
    int32_t height;
    int32_t logical_dim0;
    int32_t logical_dim1;
    int32_t pixel_format;
    int32_t byte_size;
    uint32_t bytes_per_row;
    void*   base_address;
    void*   cv_buffer;
    void*   io_surface;
} TribunusArenaInfo;

int tribunus_arena_alloc(TribunusArenaInfo* info,
                          int32_t logical_dim0,
                          int32_t logical_dim1);

void tribunus_arena_free(TribunusArenaInfo* info);

int32_t tribunus_arena_io_surface_id(const TribunusArenaInfo* info);

int tribunus_arena_lock(TribunusArenaInfo* info);

int tribunus_arena_unlock(TribunusArenaInfo* info);

#ifdef __cplusplus
}
#endif
