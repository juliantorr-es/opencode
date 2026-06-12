// Tribunus Core ML stateful prediction bridge — MLState lifecycle + stateful API.
// Requires macOS 15+ at runtime for MLState support.

#import <CoreML/CoreML.h>
#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>
#import <stdint.h>
#import <string.h>
#import <stdio.h>

#import "coreml_arena.h"
#import "coreml_state.h"

extern "C" {

// ── helpers ───────────────────────────────────────────────────────────────

/// Return a readable error string for a model-description mismatch.
static NSString* _assertFeature(MLFeatureDescription* fd,
                                 NSString* name,
                                 MLMultiArrayDataType expectedDtype,
                                 NSArray<NSNumber*>* expectedShape) {
    if (!fd) return [NSString stringWithFormat:@"feature '%@' not found in model description", name];
    if (fd.type != MLFeatureTypeMultiArray) {
        return [NSString stringWithFormat:@"feature '%@': expected MultiArray, got %d",
                name, (int)fd.type];
    }
    MLMultiArrayConstraint* mc = fd.multiArrayConstraint;
    if (mc.dataType != expectedDtype) {
        return [NSString stringWithFormat:@"feature '%@': dtype mismatch (model %d, arena %d)",
                name, (int)mc.dataType, (int)expectedDtype];
    }
    if (expectedShape != nil) {
        if (mc.shape.count != expectedShape.count) {
            return [NSString stringWithFormat:@"feature '%@': rank mismatch (model %lu, expected %lu)",
                    name, (unsigned long)mc.shape.count, (unsigned long)expectedShape.count];
        }
        for (NSUInteger i = 0; i < expectedShape.count; i++) {
            NSInteger modelDim = mc.shape[i].integerValue;
            NSInteger expectedDim = expectedShape[i].integerValue;
            if (modelDim <= 0 || expectedDim <= 0) continue; // flexible dim
            if (modelDim != expectedDim) {
                return [NSString stringWithFormat:@"feature '%@': dim[%lu] mismatch (model %ld, expected %ld)",
                        name, (unsigned long)i, (long)modelDim, (long)expectedDim];
            }
        }
    }
    return nil; // ok
}

// ── create ────────────────────────────────────────────────────────────────

int tribunus_coreml_state_create(TribunusCoreMlState** out_state, void* model_ptr) {
    if (!out_state || !model_ptr) return -1;
    *out_state = NULL;

    @autoreleasepool {
    @try {
        MLModel* mlmodel = (__bridge MLModel*)model_ptr;
        MLState* state = [mlmodel newState];
        if (!state) {
            fprintf(stderr, "coreml_state_create: newState failed (returned nil)\n");
            return -2;
        }

        *out_state = (TribunusCoreMlState*)CFBridgingRetain(state);
    } @catch (NSException* exc) {
        fprintf(stderr, "coreml_state_create EXCEPTION: %s\n",
                exc.description.UTF8String);
        return -10;
    }
    } // @autoreleasepool
    return 0;
}

// ── destroy ───────────────────────────────────────────────────────────────

void tribunus_coreml_state_destroy(TribunusCoreMlState* state) {
    if (!state) return;
    // Ownership transfer: CFBridgingRelease balances the CFBridgingRetain in create.
    // ARC takes over and deallocates the MLState.
    CFBridgingRelease(state);
}

// ── predict_stateful (FP16 MLMultiArray) ───────────────────────────────────

int tribunus_coreml_predict_stateful(
    void* model_ptr,
    TribunusCoreMlState* state,
    const char* input_name,
    void* input_arena_info,
    const char* output_name,
    void* output_arena_info) {

    if (!model_ptr || !state || !input_name || !input_arena_info ||
        !output_name || !output_arena_info)
        return -1;

    @autoreleasepool {
    @try {
        MLModel* mlmodel = (__bridge MLModel*)model_ptr;
        MLState* mlstate = (__bridge MLState*)state;
        NSError* error = nil;

        const TribunusArenaInfo* input_arena = (const TribunusArenaInfo*)input_arena_info;
        TribunusArenaInfo* output_arena = (TribunusArenaInfo*)output_arena_info;

        if (!input_arena->cv_buffer || !output_arena->base_address) return -1;

        NSString* inName = [NSString stringWithUTF8String:input_name];
        NSString* outName = [NSString stringWithUTF8String:output_name];

        // Validate against model description.
        MLModelDescription* desc = mlmodel.modelDescription;
        NSArray<NSNumber*>* shape = @[
            @(input_arena->logical_dim0),
            @(input_arena->logical_dim1),
        ];

        NSString* err = _assertFeature(
            desc.inputDescriptionsByName[inName],
            inName,
            MLMultiArrayDataTypeFloat16,
            shape);
        if (err) {
            fprintf(stderr, "coreml_predict_stateful: input validation failed: %s\n",
                    err.UTF8String);
            return -11;
        }
        err = _assertFeature(
            desc.outputDescriptionsByName[outName],
            outName,
            MLMultiArrayDataTypeFloat16,
            @[@(output_arena->logical_dim0), @(output_arena->logical_dim1)]);
        if (err) {
            fprintf(stderr, "coreml_predict_stateful: output validation failed: %s\n",
                    err.UTF8String);
            return -12;
        }

        // Wrap input CVPixelBuffer as MLMultiArray (zero-copy).
        CVPixelBufferRef pixelBuffer = (CVPixelBufferRef)input_arena->cv_buffer;
        MLMultiArray* input_ma = [[MLMultiArray alloc]
            initWithPixelBuffer:pixelBuffer shape:shape];
        if (!input_ma) {
            fprintf(stderr, "coreml_predict_stateful: input MLMultiArray failed\n");
            return -2;
        }

        // Wrap output arena memory as MLMultiArray (zero-copy).
        MLMultiArray* output_ma = [[MLMultiArray alloc]
            initWithDataPointer:output_arena->base_address
                          shape:@[@(output_arena->logical_dim0), @(output_arena->logical_dim1)]
                       dataType:MLMultiArrayDataTypeFloat16
                        strides:@[@(output_arena->logical_dim1), @1]
                    deallocator:^(void* p) { (void)p; }
                          error:&error];
        if (!output_ma) {
            fprintf(stderr, "coreml_predict_stateful: output MLMultiArray failed: %s\n",
                    error.localizedDescription.UTF8String);
            return -3;
        }

        // Build input feature provider.
        MLFeatureValue* input_fv = [MLFeatureValue featureValueWithMultiArray:input_ma];
        NSDictionary* input_dict = @{ inName: input_fv };
        MLDictionaryFeatureProvider* input_provider =
            [[MLDictionaryFeatureProvider alloc] initWithDictionary:input_dict error:&error];
        if (!input_provider) {
            fprintf(stderr, "coreml_predict_stateful: input provider failed: %s\n",
                    error.localizedDescription.UTF8String);
            return -4;
        }

        // Configure output backing and options.
        MLPredictionOptions* options = [[MLPredictionOptions alloc] init];
        options.outputBackings = @{ outName: output_ma };

        // Run stateful prediction via macOS 15+ API:
        //   -[MLModel predictionFromFeatures:usingState:options:error:]
        id<MLFeatureProvider> result = [mlmodel predictionFromFeatures:input_provider
                                                             usingState:mlstate
                                                                options:options
                                                                  error:&error];
        if (!result) {
            fprintf(stderr, "coreml_predict_stateful: prediction failed: %s\n",
                    error.localizedDescription.UTF8String);
            return -5;
        }
    } @catch (NSException* exc) {
        fprintf(stderr, "coreml_predict_stateful EXCEPTION: %s\n",
                exc.description.UTF8String);
        return -20;
    }
    } // @autoreleasepool
    return 0;
}

extern "C" void tribunus_coreml_wake_waker(void* waker);

struct TribunusCoreMlStatefulRequest {
    dispatch_semaphore_t sem;
    int status;
    BOOL completed;
    void* waker;
};

// ── predict_stateful_async ──────────────────────────────────────────

int tribunus_coreml_predict_stateful_async(
    TribunusCoreMlStatefulRequest** out_request,
    void* model_ptr,
    TribunusCoreMlState* state,
    const char* input_name,
    void* input_arena_info,
    const char* output_name,
    void* output_arena_info) {

    if (!out_request || !model_ptr || !state || !input_name || !input_arena_info ||
        !output_name || !output_arena_info)
        return -1;

    *out_request = NULL;

    @autoreleasepool {
    @try {
        MLModel* mlmodel = (__bridge MLModel*)model_ptr;
        MLState* mlstate = (__bridge MLState*)state;
        NSError* error = nil;

        const TribunusArenaInfo* input_arena = (const TribunusArenaInfo*)input_arena_info;
        TribunusArenaInfo* output_arena = (TribunusArenaInfo*)output_arena_info;

        if (!input_arena->cv_buffer || !output_arena->base_address) return -1;

        NSString* inName = [NSString stringWithUTF8String:input_name];
        NSString* outName = [NSString stringWithUTF8String:output_name];

        // Validate against model description.
        MLModelDescription* desc = mlmodel.modelDescription;
        NSArray<NSNumber*>* shape = @[
            @(input_arena->logical_dim0),
            @(input_arena->logical_dim1),
        ];

        // Wrap input CVPixelBuffer as MLMultiArray (zero-copy).
        CVPixelBufferRef pixelBuffer = (CVPixelBufferRef)input_arena->cv_buffer;
        MLMultiArray* input_ma = [[MLMultiArray alloc]
            initWithPixelBuffer:pixelBuffer shape:shape];
        if (!input_ma) {
            fprintf(stderr, "coreml_predict_stateful_async: input MLMultiArray failed\n");
            return -2;
        }

        // Wrap output arena memory as MLMultiArray (zero-copy).
        MLMultiArray* output_ma = [[MLMultiArray alloc]
            initWithDataPointer:output_arena->base_address
                          shape:@[@(output_arena->logical_dim0), @(output_arena->logical_dim1)]
                       dataType:MLMultiArrayDataTypeFloat16
                         strides:@[@(output_arena->logical_dim1), @1]
                     deallocator:^(void* p) { (void)p; }
                           error:&error];
        if (!output_ma) {
            fprintf(stderr, "coreml_predict_stateful_async: output MLMultiArray failed: %s\n",
                    error.localizedDescription.UTF8String);
            return -3;
        }

        // Build input feature provider.
        MLFeatureValue* input_fv = [MLFeatureValue featureValueWithMultiArray:input_ma];
        NSDictionary* input_dict = @{ inName: input_fv };
        MLDictionaryFeatureProvider* input_provider =
            [[MLDictionaryFeatureProvider alloc] initWithDictionary:input_dict error:&error];
        if (!input_provider) {
            fprintf(stderr, "coreml_predict_stateful_async: input provider failed: %s\n",
                    error.localizedDescription.UTF8String);
            return -4;
        }

        // Configure output backing and options.
        MLPredictionOptions* options = [[MLPredictionOptions alloc] init];
        options.outputBackings = @{ outName: output_ma };

        // Allocate request structure
        TribunusCoreMlStatefulRequest* req = (TribunusCoreMlStatefulRequest*)calloc(1, sizeof(TribunusCoreMlStatefulRequest));
        if (!req) return -6;
        req->sem = dispatch_semaphore_create(0);
        req->status = 0;
        req->completed = NO;
        req->waker = NULL;

        *out_request = req;

        // Run stateful prediction via macOS 15+ async API:
        [mlmodel predictionFromFeatures:input_provider
                             usingState:mlstate
                                options:options
                      completionHandler:^(id<MLFeatureProvider> _Nullable result, NSError * _Nullable err_cb) {
            if (!result) {
                fprintf(stderr, "coreml_predict_stateful_async callback: prediction failed: %s\n",
                        err_cb ? err_cb.localizedDescription.UTF8String : "unknown error");
                req->status = -5;
            } else {
                req->status = 0;
            }
            req->completed = YES;
            dispatch_semaphore_signal(req->sem);
            if (req->waker) {
                tribunus_coreml_wake_waker(req->waker);
                req->waker = NULL;
            }
        }];
    } @catch (NSException* exc) {
        fprintf(stderr, "coreml_predict_stateful_async EXCEPTION: %s\n",
                exc.description.UTF8String);
        return -20;
    }
    } // @autoreleasepool
    return 0;
}

// ── request lifecycle ───────────────────────────────────────────────

int tribunus_coreml_stateful_request_is_complete(TribunusCoreMlStatefulRequest* request) {
    if (!request) return -1;
    return request->completed ? 1 : 0;
}

void tribunus_coreml_stateful_request_set_waker(TribunusCoreMlStatefulRequest* request, void* waker) {
    if (!request) return;
    if (request->waker && request->waker != waker) {
        tribunus_coreml_wake_waker(request->waker);
    }
    request->waker = waker;
    if (request->completed && request->waker) {
        tribunus_coreml_wake_waker(request->waker);
        request->waker = NULL;
    }
}

int tribunus_coreml_stateful_request_wait(TribunusCoreMlStatefulRequest* request) {
    if (!request) return -1;
    dispatch_semaphore_wait(request->sem, DISPATCH_TIME_FOREVER);
    return request->status;
}

void tribunus_coreml_stateful_request_destroy(TribunusCoreMlStatefulRequest* request) {
    if (!request) return;
    if (request->waker) {
        tribunus_coreml_wake_waker(request->waker);
    }
    free(request);
}

} // extern "C"

