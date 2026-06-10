// Tribunus Core ML execution bridge — stateless prediction path.
// Stateful path requires macOS 15 SDK; will be layered in Phase 5.

#import <os/log.h>
#import <os/signpost.h>
#import <os/signpost.h>

// OSLog handle for signpost instrumentation (visible in Instruments).
// Separate from JSONL receipts — for interactive profiling, not automated analysis.
static os_log_t tribunus_coreml_log = os_log_create("com.tribunus.compute", "coreml_bridge");

#import <CoreML/CoreML.h>
#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>
#import <stdint.h>
#import <string.h>
#import <stdio.h>

#import "coreml_arena.h"

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
        // model shape may be [-1, …] (flexible); check count then concrete dims.
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

// ── load ───────────────────────────────────────────────────────────────────

/// Load a compiled Core ML model (.mlmodelc directory).
/// The path must point directly to the directory containing metadata.json.
/// Returns 0 on success.
int tribunus_coreml_load_model(void** out_model,
                                const char* model_path,
                                int64_t compute_units) {
    os_signpost_interval_begin(tribunus_coreml_log, 0, "load_model", "path=%s units=%lld", model_path, compute_units);
    if (!out_model || !model_path) return -1;
    *out_model = NULL;

    @autoreleasepool {
    @try {
        NSString* path = [NSString stringWithUTF8String:model_path];
        NSURL* url = [NSURL fileURLWithPath:path];

        NSError* error = nil;
        MLModelConfiguration* config = [[MLModelConfiguration alloc] init];
        config.computeUnits = (MLComputeUnits)compute_units;

        MLModel* model = [MLModel modelWithContentsOfURL:url
                                           configuration:config
                                                   error:&error];
        if (!model) {
            if (error) {
                fprintf(stderr, "coreml_load_model: %s\n",
                        error.localizedDescription.UTF8String);
            }
            os_signpost_interval_end(tribunus_coreml_log, 0, "load_model", "error=%s", error ? error.localizedDescription.UTF8String : "nil");
            return -2;
        }

        // Log model interface for debugging.
        MLModelDescription* desc = model.modelDescription;
        fprintf(stderr, "coreml_load_model: loaded %s\n", path.UTF8String);
        fprintf(stderr, "  inputs:\n");
        for (NSString* name in desc.inputDescriptionsByName) {
            MLFeatureDescription* ifd = desc.inputDescriptionsByName[name];
            fprintf(stderr, "    %s: %s\n",
                    name.UTF8String, ifd.description.UTF8String ?: "?");
        }
        fprintf(stderr, "  outputs:\n");
        for (NSString* name in desc.outputDescriptionsByName) {
            MLFeatureDescription* ofd = desc.outputDescriptionsByName[name];
            fprintf(stderr, "    %s: %s\n",
                    name.UTF8String, ofd.description.UTF8String ?: "?");
        }

        *out_model = (__bridge_retained void*)model;
    } @catch (NSException* exc) {
        os_signpost_interval_end(tribunus_coreml_log, 0, "load_model", "exception=%s", exc.description.UTF8String);
        fprintf(stderr, "coreml_load_model EXCEPTION: %s\n",
                exc.description.UTF8String);
        return -10;
    }
    } // @autoreleasepool
    os_signpost_interval_end(tribunus_coreml_log, 0, "load_model", "ok");
    return 0;
}

/// Release a loaded model.
void tribunus_coreml_free_model(void* model_ptr) {
    if (!model_ptr) return;
    CFBridgingRelease(model_ptr);
}

// ── predict (FP32 MLMultiArray) ────────────────────────────────────────────

int tribunus_coreml_predict(
    void* model_ptr,
    const char* input_name,
    const TribunusArenaInfo* input_arena,
    const char* output_name,
    const TribunusArenaInfo* output_arena) {

    os_signpost_interval_begin(tribunus_coreml_log, 0, "predict", "model=%p", model_ptr);

    if (!model_ptr || !input_name || !input_arena || !output_name || !output_arena) {
        os_signpost_interval_end(tribunus_coreml_log, 0, "predict", "null_args");
        return -1;
    }

    @autoreleasepool {
    @try {
        MLModel* mlmodel = (__bridge MLModel*)model_ptr;
        NSError* error = nil;

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
            MLMultiArrayDataTypeFloat32,
            shape);
        if (err) {
            fprintf(stderr, "coreml_predict: input validation failed: %s\n",
                    err.UTF8String);
            return -11;
        }
        err = _assertFeature(
            desc.outputDescriptionsByName[outName],
            outName,
            MLMultiArrayDataTypeFloat32,
            @[@(output_arena->logical_dim0), @(output_arena->logical_dim1)]);
        if (err) {
            fprintf(stderr, "coreml_predict: output validation failed: %s\n",
                    err.UTF8String);
            return -12;
        }

        MLMultiArray* input_ma = [[MLMultiArray alloc]
            initWithDataPointer:input_arena->base_address
                          shape:shape
                       dataType:MLMultiArrayDataTypeFloat32
                        strides:@[@(input_arena->logical_dim1), @1]
                    deallocator:^(void* p) { (void)p; }
                          error:&error];
        if (!input_ma) {
            fprintf(stderr, "coreml_predict: input MLMultiArray failed: %s\n",
                    error.localizedDescription.UTF8String);
            return -2;
        }

        MLMultiArray* output_ma = [[MLMultiArray alloc]
            initWithDataPointer:output_arena->base_address
                          shape:@[@(output_arena->logical_dim0), @(output_arena->logical_dim1)]
                       dataType:MLMultiArrayDataTypeFloat32
                        strides:@[@(output_arena->logical_dim1), @1]
                    deallocator:^(void* p) { (void)p; }
                          error:&error];
        if (!output_ma) {
            fprintf(stderr, "coreml_predict: output MLMultiArray failed: %s\n",
                    error.localizedDescription.UTF8String);
            return -3;
        }

        MLFeatureValue* input_fv = [MLFeatureValue featureValueWithMultiArray:input_ma];
        NSDictionary* input_dict = @{ inName: input_fv };
        MLDictionaryFeatureProvider* input_provider =
            [[MLDictionaryFeatureProvider alloc] initWithDictionary:input_dict error:&error];
        if (!input_provider) return -4;

        MLPredictionOptions* options = [[MLPredictionOptions alloc] init];
        options.outputBackings = @{ outName: output_ma };

        id<MLFeatureProvider> result = [mlmodel predictionFromFeatures:input_provider
                                                                options:options
                                                                  error:&error];
        if (!result) {
            fprintf(stderr, "coreml_predict: prediction failed: %s\n",
                    error.localizedDescription.UTF8String);
            return -5;
        }
    } @catch (NSException* exc) {
        fprintf(stderr, "coreml_predict EXCEPTION: %s\n",
                exc.description.UTF8String);
        os_signpost_interval_end(tribunus_coreml_log, 0, "predict", "exception=%s", exc.description.UTF8String);
        return -20;
    }
    } // @autoreleasepool
    os_signpost_interval_end(tribunus_coreml_log, 0, "predict", "ok");
    return 0;
}

// ── predict_pixelbuffer (FP16 IOSurface) ───────────────────────────────────

int tribunus_coreml_predict_pixelbuffer(
    void* model_ptr,
    const char* input_name,
    TribunusArenaInfo* input_arena,
    const char* output_name,
    TribunusArenaInfo* output_arena) {

    if (!model_ptr || !input_name || !input_arena || !output_name || !output_arena ||
        !input_arena->cv_buffer || !output_arena->base_address)
        return -1;

    @autoreleasepool {
    @try {
        MLModel* mlmodel = (__bridge MLModel*)model_ptr;
        NSError* error = nil;

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
            fprintf(stderr, "coreml_predict_pixelbuffer: input validation failed: %s\n",
                    err.UTF8String);
            return -11;
        }
        err = _assertFeature(
            desc.outputDescriptionsByName[outName],
            outName,
            MLMultiArrayDataTypeFloat16,
            @[@(output_arena->logical_dim0), @(output_arena->logical_dim1)]);
        if (err) {
            fprintf(stderr, "coreml_predict_pixelbuffer: output validation failed: %s\n",
                    err.UTF8String);
            return -12;
        }

        CVPixelBufferRef pixelBuffer = (CVPixelBufferRef)input_arena->cv_buffer;

        MLMultiArray* input_ma = [[MLMultiArray alloc]
            initWithPixelBuffer:pixelBuffer shape:shape];
        if (!input_ma) return -2;

        MLMultiArray* output_ma = [[MLMultiArray alloc]
            initWithDataPointer:output_arena->base_address
                          shape:@[@(output_arena->logical_dim0), @(output_arena->logical_dim1)]
                       dataType:MLMultiArrayDataTypeFloat16
                        strides:@[@(output_arena->logical_dim1), @1]
                    deallocator:^(void* p) { (void)p; }
                          error:&error];
        if (!output_ma) return -3;

        MLFeatureValue* input_fv = [MLFeatureValue featureValueWithMultiArray:input_ma];
        NSDictionary* input_dict = @{ inName: input_fv };
        MLDictionaryFeatureProvider* input_provider =
            [[MLDictionaryFeatureProvider alloc] initWithDictionary:input_dict error:&error];
        if (!input_provider) return -4;

        MLPredictionOptions* options = [[MLPredictionOptions alloc] init];
        options.outputBackings = @{ outName: output_ma };

        id<MLFeatureProvider> result = [mlmodel predictionFromFeatures:input_provider
                                                                options:options
                                                                  error:&error];
        if (!result) {
            fprintf(stderr, "coreml_predict_pixelbuffer: prediction failed: %s\n",
                    error.localizedDescription.UTF8String);
            return -5;
        }
    } @catch (NSException* exc) {
        fprintf(stderr, "coreml_predict_pixelbuffer EXCEPTION: %s\n",
                exc.description.UTF8String);
        return -20;
    }
    } // @autoreleasepool
    return 0;
}

} // extern "C"
