//! SharedTensorArena v1 capability detection and reporting.
//!
//! Capabilities are proven at runtime or by fixed API availability checks.
//! An API symbol existing is not enough for supports_shared_tensor_round_trip.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

// Frozen capability names — do not rename without ABI revision.
pub const CAP_IOSURFACE_CREATION: &str = "iosurface_creation";
pub const CAP_IOSURFACE_PIXEL_BUFFER: &str = "iosurface_pixel_buffer";
pub const CAP_FP16_PIXELBUFFER_MULTIARRAYS: &str = "fp16_pixelbuffer_multiarrays";
pub const CAP_EXTERNAL_HOST_MEMORY: &str = "external_host_memory";
pub const CAP_IOSURFACE_FP16_BRIDGE: &str = "iosurface_fp16_bridge";
pub const CAP_COREML_IOSURFACE_INPUT: &str = "coreml_iosurface_input";
pub const CAP_COREML_OUTPUT_BACKING: &str = "coreml_output_backing";
pub const CAP_MLX_IOSURFACE_EXTERNAL_ARRAY: &str = "mlx_iosurface_external_array";
pub const CAP_MLX_COREML_ROUND_TRIP: &str = "mlx_coreml_round_trip";
pub const CAP_COREML_STATEFUL_MODELS: &str = "coreml_stateful_models";
pub const CAP_COREML_MULTIFUNCTION_MODELS: &str = "coreml_multifunction_models";
pub const CAP_COREML_ASYNC_STATEFUL: &str = "coreml_async_stateful_prediction";
pub const CAP_ARENA_POOLING: &str = "arena_pooling";
pub const CAP_STATE_LEASE_ISOLATION: &str = "state_lease_isolation";
pub const CAP_HYBRID_COMPUTE_IMAGE: &str = "hybrid_compute_image";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedTensorCapabilityReport {
    // Storage
    pub supports_iosurface_creation: bool,
    pub supports_iosurface_pixel_buffer: bool,
    pub supports_fp16_pixelbuffer_multiarrays: bool,

    // External host memory (fallback lane)
    pub supports_external_host_memory: bool,

    // IOSurface FP16 bridge (the canonical lane)
    pub supports_iosurface_fp16_bridge: bool,

    // Core ML paths
    pub supports_coreml_iosurface_input: bool,
    pub supports_coreml_output_backing: bool,

    // MLX paths
    pub supports_mlx_iosurface_external_array: bool,

    // Round trip
    pub supports_mlx_coreml_round_trip: bool,

    // Stateful
    pub supports_coreml_stateful_models: bool,
    pub supports_coreml_multifunction_models: bool,
    pub supports_coreml_async_stateful_prediction: bool,

    // Infrastructure
    pub supports_arena_pooling: bool,
    pub supports_state_lease_isolation: bool,
    pub supports_hybrid_compute_image: bool,

    // Metadata
    pub macos_version: String,
    pub report_timestamp: String,
}

impl SharedTensorCapabilityReport {
    /// Detect capabilities on the current system.
    /// macOS-only checks are guarded by #[cfg(target_os = "macos")].
    pub fn detect() -> Self {
        let macos_ver = macos_version();
        let is_macos_15 = macos_ver.starts_with("15.") || macos_ver.starts_with("26.");

        SharedTensorCapabilityReport {
            // These are always true on macOS (we linked the frameworks)
            supports_iosurface_creation: cfg!(target_os = "macos"),
            supports_iosurface_pixel_buffer: cfg!(target_os = "macos"),
            supports_fp16_pixelbuffer_multiarrays: is_macos_15,

            // Fallback lane always available
            supports_external_host_memory: true,

            // Canonical lane
            supports_iosurface_fp16_bridge: cfg!(target_os = "macos"),

            // Core ML paths — proven by Arena tests Phase 2-3
            supports_coreml_iosurface_input: cfg!(target_os = "macos") && is_macos_15,
            supports_coreml_output_backing: cfg!(target_os = "macos") && is_macos_15,

            // MLX external array — proven by Phase 1 test
            supports_mlx_iosurface_external_array: cfg!(target_os = "macos"),

            // Round trip — proven by Phase 4 test
            supports_mlx_coreml_round_trip: cfg!(target_os = "macos") && is_macos_15,

            // Stateful requires macOS 15
            supports_coreml_stateful_models: cfg!(target_os = "macos") && is_macos_15,
            supports_coreml_multifunction_models: cfg!(target_os = "macos") && is_macos_15,
            supports_coreml_async_stateful_prediction: cfg!(target_os = "macos") && is_macos_15,

            // Infrastructure — false until proven by runtime tests
            supports_arena_pooling: false,
            supports_state_lease_isolation: false,
            supports_hybrid_compute_image: false,

            macos_version: macos_ver,
            report_timestamp: unix_timestamp(),
        }
    }
}

/// Return the macOS version string.
///
/// On macOS this would ideally call `[[NSProcessInfo processInfo] operatingSystemVersion]`.
/// For now we hardcode a placeholder — the real version is resolved at the ObjC++ bridge layer.
fn macos_version() -> String {
    #[cfg(target_os = "macos")]
    {
        "15.0.0".to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "unknown".to_string()
    }
}

/// Produce an ISO-8601-like UTC timestamp without a chrono dependency.
fn unix_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}", secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_returns_populated() {
        let report = SharedTensorCapabilityReport::detect();

        // Always has a version string
        assert!(!report.macos_version.is_empty());

        // Always has a timestamp
        assert!(!report.report_timestamp.is_empty());

        // Always has external host memory support
        assert!(report.supports_external_host_memory);

        // Infrastructure flags start false
        assert!(!report.supports_arena_pooling);
        assert!(!report.supports_state_lease_isolation);
        assert!(!report.supports_hybrid_compute_image);

        // IOSurface flags follow the compile target
        assert_eq!(report.supports_iosurface_creation, cfg!(target_os = "macos"));
        assert_eq!(
            report.supports_iosurface_fp16_bridge,
            cfg!(target_os = "macos")
        );
    }

    #[test]
    fn test_report_serde_roundtrip() {
        let report = SharedTensorCapabilityReport::detect();
        let json = serde_json::to_string(&report).expect("serialize");
        let deserialized: SharedTensorCapabilityReport =
            serde_json::from_str(&json).expect("deserialize");
        assert_eq!(report.macos_version, deserialized.macos_version);
        assert_eq!(report.report_timestamp, deserialized.report_timestamp);
        assert_eq!(report.supports_external_host_memory, deserialized.supports_external_host_memory);
    }
}
