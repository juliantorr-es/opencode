// Tribunus Core ML stateful prediction bridge — MLState lifecycle + stateful API.
// Requires macOS 15+ at runtime.

#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Opaque handle for a Core ML state object (MLState).
typedef struct TribunusCoreMlState TribunusCoreMlState;

// Opaque handle for a stateful prediction request (in-flight).
typedef struct TribunusCoreMlStatefulRequest TribunusCoreMlStatefulRequest;

// Create a new MLState from a loaded model.
// Returns 0 on success, negative on error.
int tribunus_coreml_state_create(
    TribunusCoreMlState** out_state,
    void* model_ptr
);

// Destroy a state object. Safe to call with null.
void tribunus_coreml_state_destroy(TribunusCoreMlState* state);

// Run stateful prediction: input arena -> model + state -> output arena.
// The state is read and updated atomically.
// Returns 0 on success, negative on error.
int tribunus_coreml_predict_stateful(
    void* model_ptr,
    TribunusCoreMlState* state,
    const char* input_name,
    void* input_arena_info,    // const TribunusArenaInfo*
    const char* output_name,
    void* output_arena_info     // TribunusArenaInfo* (mutable)
);

// Start an async stateful prediction. Returns immediately.
// The request handle outlives the call; poll or wait for completion.
// Returns 0 on success, negative on error.
int tribunus_coreml_predict_stateful_async(
    TribunusCoreMlStatefulRequest** out_request,
    void* model_ptr,
    TribunusCoreMlState* state,
    const char* input_name,
    void* input_arena_info,
    const char* output_name,
    void* output_arena_info
);

// Check if an async request has completed.
// Returns 1 if complete, 0 if still pending, negative on error.
int tribunus_coreml_stateful_request_is_complete(TribunusCoreMlStatefulRequest* request);

// Set the Rust waker to wake when complete.
void tribunus_coreml_stateful_request_set_waker(TribunusCoreMlStatefulRequest* request, void* waker);

// Wait for async request completion (blocking). Returns 0 on success.
int tribunus_coreml_stateful_request_wait(TribunusCoreMlStatefulRequest* request);

// Destroy a stateful request handle.
void tribunus_coreml_stateful_request_destroy(TribunusCoreMlStatefulRequest* request);

#ifdef __cplusplus
}
#endif
