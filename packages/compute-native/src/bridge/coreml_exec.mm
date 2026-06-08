// Tribunus Core ML execution bridge — stateless prediction path.
// Stateful path requires macOS 15 SDK; will be layered in Phase 5.

#import <CoreML/CoreML.h>
#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>
#import <stdint.h>
#import <string.h>
#import <stdio.h>

#import "coreml_arena.h"

extern "C" {

/// Load a compiled Core ML model (.mlmodelc directory).
/// Returns 0 on success.
int tribunus_coreml_load_model(void** out_model,
                                const char* model_path) {
    if (!out_model || !model_path) return -1;
    *out_model = NULL;

    @autoreleasepool {
        NSString* path = [NSString stringWithUTF8String:model_path];
        NSURL* url = [NSURL fileURLWithPath:path];

        NSError* error = nil;
        MLModelConfiguration* config = [[MLModelConfiguration alloc] init];
        config.computeUnits = MLComputeUnitsCPUAndGPU;

        MLModel* model = [MLModel modelWithContentsOfURL:url
                                           configuration:config
                                                   error:&error];
        if (!model) return -2;

        *out_model = (__bridge_retained void*)model;
    }
    return 0;
}

/// Release a loaded model.
void tribunus_coreml_free_model(void* model_ptr) {
    if (!model_ptr) return;
    CFRelease((__bridge CFTypeRef)(__bridge_transfer id)model_ptr);
}

/// Run prediction: input arena → model → output arena.
/// Both arenas must be FP32 (Float32) for the neural network format.
/// Returns 0 on success.
int tribunus_coreml_predict(
    void* model_ptr,
    const char* input_name,
    const TribunusArenaInfo* input_arena,
    const char* output_name,
    const TribunusArenaInfo* output_arena) {

    if (!model_ptr || !input_name || !input_arena || !output_name || !output_arena)
        return -1;

    @autoreleasepool {
        MLModel* mlmodel = (__bridge MLModel*)model_ptr;
        NSError* error = nil;

        NSArray<NSNumber*>* shape = @[
            @(input_arena->logical_dim0),
            @(input_arena->logical_dim1),
        ];

        // Build input MLMultiArray backed by the input arena.
        MLMultiArray* input_ma = [[MLMultiArray alloc]
            initWithDataPointer:input_arena->base_address
                          shape:shape
                       dataType:MLMultiArrayDataTypeFloat32
                        strides:@[@(input_arena->logical_dim1), @1]
                    deallocator:^(void* p) { (void)p; }
                          error:&error];
        if (!input_ma) return -2;

        // Build output MLMultiArray backed by the output arena.
        MLMultiArray* output_ma = [[MLMultiArray alloc]
            initWithDataPointer:output_arena->base_address
                          shape:@[@(output_arena->logical_dim0), @(output_arena->logical_dim1)]
                       dataType:MLMultiArrayDataTypeFloat32
                        strides:@[@(output_arena->logical_dim1), @1]
                    deallocator:^(void* p) { (void)p; }
                          error:&error];
        if (!output_ma) return -3;

        // Input feature provider.
        MLFeatureValue* input_fv = [MLFeatureValue featureValueWithMultiArray:input_ma];
        NSDictionary* input_dict = @{ [NSString stringWithUTF8String:input_name]: input_fv };
        MLDictionaryFeatureProvider* input_provider =
            [[MLDictionaryFeatureProvider alloc] initWithDictionary:input_dict error:&error];
        if (!input_provider) return -4;

        // Output backings.
        MLPredictionOptions* options = [[MLPredictionOptions alloc] init];
        options.outputBackings = @{
            [NSString stringWithUTF8String:output_name]: output_ma,
        };

        // Run.
        id<MLFeatureProvider> result = [mlmodel predictionFromFeatures:input_provider
                                                                options:options
                                                                  error:&error];
        if (!result) return -5;
    }
    return 0;
}

/// Run prediction with IOSurface-backed pixel buffer input and output.
/// Input arena must be FP16 (kCVPixelFormatType_OneComponent16Half).
/// Output arena must be FP16. Returns 0 on success.
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
        MLModel* mlmodel = (__bridge MLModel*)model_ptr;
        NSError* error = nil;

        CVPixelBufferRef pixelBuffer = (CVPixelBufferRef)input_arena->cv_buffer;

        // Shape in logical dimension order (same as MLMultiArray convention).
        NSArray<NSNumber*>* input_shape = @[
            @(input_arena->logical_dim0),
            @(input_arena->logical_dim1),
        ];

        // Build input MLMultiArray from the IOSurface-backed CVPixelBuffer.
        // This avoids a copy — Core ML reads directly from the surface.
        MLMultiArray* input_ma = [[MLMultiArray alloc]
            initWithPixelBuffer:pixelBuffer shape:input_shape];
        if (!input_ma) return -2;

        // Build output MLMultiArray backed by the output arena's locked memory.
        MLMultiArray* output_ma = [[MLMultiArray alloc]
            initWithDataPointer:output_arena->base_address
                          shape:@[@(output_arena->logical_dim0), @(output_arena->logical_dim1)]
                       dataType:MLMultiArrayDataTypeFloat16
                        strides:@[@(output_arena->logical_dim1), @1]
                    deallocator:^(void* p) { (void)p; }
                          error:&error];
        if (!output_ma) return -3;

        // Input feature provider.
        MLFeatureValue* input_fv = [MLFeatureValue featureValueWithMultiArray:input_ma];
        NSDictionary* input_dict = @{ [NSString stringWithUTF8String:input_name]: input_fv };
        MLDictionaryFeatureProvider* input_provider =
            [[MLDictionaryFeatureProvider alloc] initWithDictionary:input_dict error:&error];
        if (!input_provider) return -4;

        // Output backings — Core ML writes directly into the output arena.
        MLPredictionOptions* options = [[MLPredictionOptions alloc] init];
        options.outputBackings = @{
            [NSString stringWithUTF8String:output_name]: output_ma,
        };

        // Run.
        id<MLFeatureProvider> result = [mlmodel predictionFromFeatures:input_provider
                                                                options:options
                                                                  error:&error];
        if (!result) return -5;
    }
    return 0;
}

} // extern "C"
