fn main() {
    napi_build::setup();

    // Compile the ObjC++ Core ML / IOSurface bridge.
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/bridge/coreml_arena.mm")
            .flag("-fobjc-arc")
            .flag("-std=c++17")
            .compile("coreml_arena");
        cc::Build::new()
            .file("src/bridge/coreml_exec.mm")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-std=c++17")
            .compile("coreml_exec");
        cc::Build::new()
            .file("src/bridge/coreml_state.mm")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-std=c++17")
            .compile("coreml_state");
        println!("cargo:rustc-link-lib=framework=CoreML");
        println!("cargo:rustc-link-lib=framework=CoreVideo");
        println!("cargo:rustc-link-lib=framework=IOSurface");
    }

    // The addon is normally loaded
    // the N-API symbols. `cargo test` builds a standalone harness instead, so
    // on macOS we keep those symbols as runtime lookups rather than forcing a
    // machine-specific libnode dependency into the build artifacts.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-undefined,dynamic_lookup");
    }
}
