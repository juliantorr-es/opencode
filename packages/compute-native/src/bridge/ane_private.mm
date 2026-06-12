#import "ane_private.h"
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurfaceRef.h>

#pragma mark - Private ANE Class References

static Class g_Desc;  // _ANEInMemoryModelDescriptor
static Class g_IMM;   // _ANEInMemoryModel
static Class g_AR;    // _ANERequest
static Class g_AIO;   // _ANEIOSurfaceObject
static bool  g_init;
static int   g_compile_count;

#pragma mark - TribunusAneProgram Struct

struct TribunusAneProgram {
    void *model;       // _ANEInMemoryModel (retained via CFBridgingRetain)
    void *tmpDir;      // NSString* tmp directory (retained)
    char tag[256];
    bool loaded;
};

#pragma mark - Init

int tribunus_ane_init(void) {
    if (g_init) return 1;

    void *h = dlopen("/System/Library/PrivateFrameworks/"
                     "AppleNeuralEngine.framework/AppleNeuralEngine", RTLD_NOW);
    if (!h) return 0;

    g_Desc = NSClassFromString(@"_ANEInMemoryModelDescriptor");
    g_IMM  = NSClassFromString(@"_ANEInMemoryModel");
    g_AR   = NSClassFromString(@"_ANERequest");
    g_AIO  = NSClassFromString(@"_ANEIOSurfaceObject");

    if (!g_Desc || !g_IMM || !g_AR || !g_AIO) return 0;

    g_init = true;
    g_compile_count = 0;
    return 1;
}

#pragma mark - Compile

int tribunus_ane_compile_mil(
    TribunusAneProgram** out_program,
    const char* mil_text,
    const char* program_tag
) {
    if (!out_program) return -1;
    *out_program = NULL;

    if (!g_init || !mil_text) return -2;

    @autoreleasepool {
        NSData *milData = [NSData dataWithBytes:mil_text length:strlen(mil_text)];
        NSDictionary *wdict = @{}; // Initially empty weight dict (external management)

        // Step 1: Create descriptor
        id desc = ((id(*)(Class,SEL,id,id,id))objc_msgSend)(
            g_Desc, @selector(modelWithMILText:weights:optionsPlist:),
            milData, wdict, nil);
        if (!desc) return -3;

        // Step 2: Create in-memory model
        id model = ((id(*)(Class,SEL,id))objc_msgSend)(
            g_IMM, @selector(inMemoryModelWithDescriptor:), desc);
        if (!model) return -4;

        // Step 3: Pre-populate temp directory
        id hexId = ((id(*)(id,SEL))objc_msgSend)(model, @selector(hexStringIdentifier));
        NSString *tmpDir = [NSTemporaryDirectory() stringByAppendingPathComponent:hexId];
        NSFileManager *fm = [NSFileManager defaultManager];
        [fm createDirectoryAtPath:[tmpDir stringByAppendingPathComponent:@"weights"]
            withIntermediateDirectories:YES attributes:nil error:nil];
        [milData writeToFile:[tmpDir stringByAppendingPathComponent:@"model.mil"]
                  atomically:YES];

        // Step 4: Compile
        NSError *e = nil;
        BOOL ok = ((BOOL(*)(id,SEL,unsigned int,id,NSError**))objc_msgSend)(
            model, @selector(compileWithQoS:options:error:), 21, @{}, &e);
        if (!ok) {
            if (e) NSLog(@"ANE compile error: %@", e);
            [fm removeItemAtPath:tmpDir error:nil];
            return -5;
        }

        // Step 5: Load into ANE
        ok = ((BOOL(*)(id,SEL,unsigned int,id,NSError**))objc_msgSend)(
            model, @selector(loadWithQoS:options:error:), 21, @{}, &e);
        if (!ok) {
            [fm removeItemAtPath:tmpDir error:nil];
            return -6;
        }

        g_compile_count++;

        // Wrap in TribunusAneProgram
        TribunusAneProgram *prog = (TribunusAneProgram *)calloc(1, sizeof(TribunusAneProgram));
        prog->model = (void *)CFBridgingRetain(model);
        prog->tmpDir = (void *)CFBridgingRetain(tmpDir);
        prog->loaded = true;
        if (program_tag) {
            strlcpy(prog->tag, program_tag, sizeof(prog->tag));
        }

        *out_program = prog;
        return 0;
    }
}

#pragma mark - Evaluation

int tribunus_ane_eval(
    TribunusAneProgram* prog,
    void** inputs, int num_inputs,
    void** outputs, int num_outputs
) {
    if (!prog || !prog->loaded || !inputs || !outputs) return 0;
    if (num_inputs <= 0 || num_outputs <= 0) return 0;

    @autoreleasepool {
        // Wrap inputs as _ANEIOSurfaceObject
        NSMutableArray *inArr = [NSMutableArray arrayWithCapacity:num_inputs];
        NSMutableArray *inIdx = [NSMutableArray arrayWithCapacity:num_inputs];
        for (int i = 0; i < num_inputs; i++) {
            IOSurfaceRef surf = (IOSurfaceRef)inputs[i];
            id wrapped = ((id(*)(Class,SEL,IOSurfaceRef))objc_msgSend)(
                g_AIO, @selector(objectWithIOSurface:), surf);
            if (!wrapped) return 0;
            [inArr addObject:wrapped];
            [inIdx addObject:@(i)];
        }

        // Wrap outputs
        NSMutableArray *outArr = [NSMutableArray arrayWithCapacity:num_outputs];
        NSMutableArray *outIdx = [NSMutableArray arrayWithCapacity:num_outputs];
        for (int i = 0; i < num_outputs; i++) {
            IOSurfaceRef surf = (IOSurfaceRef)outputs[i];
            id wrapped = ((id(*)(Class,SEL,IOSurfaceRef))objc_msgSend)(
                g_AIO, @selector(objectWithIOSurface:), surf);
            if (!wrapped) return 0;
            [outArr addObject:wrapped];
            [outIdx addObject:@(i)];
        }

        // Build request
        id req = ((id(*)(Class,SEL,id,id,id,id,id,id,id))objc_msgSend)(
            g_AR,
            @selector(requestWithInputs:inputIndices:outputs:outputIndices:
                      weightsBuffer:perfStats:procedureIndex:),
            inArr, inIdx, outArr, outIdx, nil, nil, @0);
        if (!req) return 0;

        // Evaluate
        id model = (__bridge id)prog->model;
        NSError *e = nil;
        BOOL ok = ((BOOL(*)(id,SEL,unsigned int,id,id,NSError**))objc_msgSend)(
            model, @selector(evaluateWithQoS:options:request:error:),
            21, @{}, req, &e);

        if (!ok && e) {
            NSLog(@"tribunus_ane_eval ERROR [%s]: %@", prog->tag, e);
        }
        return ok ? 1 : 0;
    }
}

#pragma mark - Release

void tribunus_ane_release_program(TribunusAneProgram* prog) {
    if (!prog) return;

    @autoreleasepool {
        if (prog->loaded && prog->model) {
            id model = (__bridge id)prog->model;
            NSError *e = nil;
            ((BOOL(*)(id,SEL,unsigned int,NSError**))objc_msgSend)(
                model, @selector(unloadWithQoS:error:), 21, &e);
        }

        if (prog->tmpDir) {
            NSString *td = (__bridge id)prog->tmpDir;
            [[NSFileManager defaultManager] removeItemAtPath:td error:nil];
            CFRelease(prog->tmpDir);
            prog->tmpDir = NULL;
        }

        if (prog->model) {
            CFRelease(prog->model);
            prog->model = NULL;
        }

        free(prog);
    }
}

int tribunus_ane_compile_count(void) {
    return g_compile_count;
}

#pragma mark - Weight Reloading

int tribunus_ane_program_reload_weights(
    TribunusAneProgram* prog,
    const char* weight_path,
    const void* weight_data,
    uint64_t weight_size
) {
    if (!g_init || !prog || !prog->model || !prog->tmpDir || !weight_path || !weight_data) return 0;

    @autoreleasepool {
        id model = (__bridge id)prog->model;
        NSString *dir = (__bridge NSString *)prog->tmpDir;

        // Unload from ANE
        if (prog->loaded) {
            NSError *e = nil;
            ((BOOL(*)(id,SEL,unsigned int,NSError**))objc_msgSend)(
                model, @selector(unloadWithQoS:error:), 21, &e);
            prog->loaded = false;
        }

        // Update weight file on disk
        NSString *relPath = [NSString stringWithUTF8String:weight_path];
        // Remove "@model_path/" prefix if present
        if ([relPath hasPrefix:@"@model_path/"]) {
            relPath = [relPath substringFromIndex:12];
        }
        NSString *fullPath = [dir stringByAppendingPathComponent:relPath];
        NSString *parentDir = [fullPath stringByDeletingLastPathComponent];
        NSFileManager *fm = [NSFileManager defaultManager];
        [fm createDirectoryAtPath:parentDir withIntermediateDirectories:YES attributes:nil error:nil];

        NSData *data = [NSData dataWithBytes:weight_data length:weight_size];
        [data writeToFile:fullPath atomically:NO];

        // Also write as the "data" file in the root directory (Orion discovery)
        [data writeToFile:[dir stringByAppendingPathComponent:@"data"] atomically:NO];

        // Reload with new weights
        NSError *e = nil;
        BOOL ok = ((BOOL(*)(id,SEL,unsigned int,id,NSError**))objc_msgSend)(
            model, @selector(loadWithQoS:options:error:), 21, @{}, &e);
        if (!ok) {
            if (e) NSLog(@"tribunus_ane_program_reload_weights LOAD FAILED: %@", e);
            return 0;
        }
        prog->loaded = true;
        return 1;
    }
}
