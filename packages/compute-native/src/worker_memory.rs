//! Platform-specific memory monitoring and MLX limit configuration.
//!
//! Provides process RSS sampling via mach/libc on macOS, physical memory
//! discovery via sysctl, and wired MLX Metal memory-limit helpers.

use std::ffi::CString;
use std::os::raw::c_char;
use std::os::raw::c_int;
use std::os::raw::c_void;
use std::time::Instant;

use crate::compute_image;

// ── Machine profile ────────────────────────────────────────────────────────

/// Describes the physical machine's memory configuration and GPU family.
#[derive(Debug, Clone)]
pub struct MachineProfile {
    /// Total physical RAM installed, in bytes.
    pub total_physical_bytes: u64,
    /// Available bytes after subtracting the system reservation.
    pub usable_bytes: u64,
    /// Human-readable model string, e.g. "Apple M1 Pro".
    pub model: String,
    /// GPU family identifier, e.g. "apple-mtl" for Apple Silicon.
    pub gpu_family: String,
}

/// Detect the machine's memory and GPU profile using platform sysctls.
///
/// On macOS this reads `hw.memsize` for total physical memory and reserves a
/// portion (2 GiB for ≤16 GiB machines, proportionally more for larger systems)
/// so the MLX allocator does not contend with system/UI memory pressure.
pub fn detect_machine_profile() -> MachineProfile {
    let total = total_physical_bytes();
    let usable = usable_after_system_reserve(total);
    let model = detect_model_string();
    let gpu_family = detect_gpu_family();
    MachineProfile {
        total_physical_bytes: total,
        usable_bytes: usable,
        model,
        gpu_family,
    }
}

/// Read `hw.memsize` via sysctl, returning 0 on non-macOS.
fn total_physical_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn sysctlbyname(
                name: *const c_char,
                oldp: *mut c_void,
                oldlenp: *mut usize,
                newp: *mut c_void,
                newlen: usize,
            ) -> c_int;
        }
        let mut value: u64 = 0;
        let mut size = std::mem::size_of::<u64>();
        let name = CString::new("hw.memsize").expect("CString");
        let ret = unsafe {
            sysctlbyname(
                name.as_ptr(),
                &mut value as *mut _ as *mut c_void,
                &mut size as *mut usize,
                std::ptr::null_mut(),
                0,
            )
        };
        if ret == 0 && value > 0 {
            return value;
        }
    }
    0
}

/// Subtract a system memory reserve based on total physical RAM.
///
/// Heuristic (macOS typically reserves 1–2 GiB at the 8–16 GiB range):
///   ≤8 GiB  → 1 GiB reserve
///   ≤16 GiB → 2 GiB reserve
///   ≤32 GiB → 4 GiB reserve
///   >32 GiB → 8 GiB reserve
fn usable_after_system_reserve(total: u64) -> u64 {
    const GIB: u64 = 1024 * 1024 * 1024;
    let reserve = if total <= 8 * GIB {
        1 * GIB
    } else if total <= 16 * GIB {
        2 * GIB
    } else if total <= 32 * GIB {
        4 * GIB
    } else {
        8 * GIB
    };
    total.saturating_sub(reserve)
}

/// Best-effort model string from sysctl.
///
/// On Intel Macs reads `machdep.cpu.brand_string`; on Apple Silicon reads
/// `hw.model` (e.g. "Mac14,2").  Falls back to "Unknown" when sysctl fails.
fn detect_model_string() -> String {
    #[cfg(target_os = "macos")]
    {
        // Try machdep.cpu.brand_string first (works on Intel, may work via
        // Rosetta on ARM).
        let brand = sysctl_string("machdep.cpu.brand_string");
        if !brand.is_empty() {
            return brand;
        }
        // Fall back to hw.model.
        let model = sysctl_string("hw.model");
        if !model.is_empty() {
            return model;
        }
    }
    "Unknown".to_string()
}

/// Detect the GPU family string.
///
/// Returns `"apple-mtl"` on arm64 macOS (Apple Silicon unified architecture),
/// `"unknown"` otherwise.
fn detect_gpu_family() -> String {
    #[cfg(target_os = "macos")]
    {
        let arch = sysctl_string("hw.machine");
        if arch == "arm64" {
            return "apple-mtl".to_string();
        }
    }
    "unknown".to_string()
}

/// Read a sysctl string value by name. Returns empty string on failure.
fn sysctl_string(name: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn sysctlbyname(
                name: *const c_char,
                oldp: *mut c_void,
                oldlenp: *mut usize,
                newp: *mut c_void,
                newlen: usize,
            ) -> c_int;
        }
        let cname = CString::new(name).expect("CString");
        // Query required buffer size.
        let mut len: usize = 0;
        let ret = unsafe {
            sysctlbyname(cname.as_ptr(), std::ptr::null_mut(), &mut len, std::ptr::null_mut(), 0)
        };
        if ret != 0 || len == 0 {
            return String::new();
        }
        let mut buf = vec![0u8; len];
        let ret = unsafe {
            sysctlbyname(
                cname.as_ptr(),
                buf.as_mut_ptr() as *mut c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if ret != 0 {
            return String::new();
        }
        // Trim trailing NUL.
        while buf.last() == Some(&0) {
            buf.pop();
        }
        String::from_utf8_lossy(&buf).to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = name;
        String::new()
    }
}

// ── Process RSS sampling ───────────────────────────────────────────────────

/// Sample the resident set size (RSS) of an arbitrary process in bytes.
///
/// On macOS uses `proc_pid_rusage` (RUSAGE_INFO_V2).  Returns 0 on any
/// failure and **never panics**.
pub fn sample_process_rss(pid: u32) -> u64 {
    #[cfg(target_os = "macos")]
    {
        use libc::rusage_info_v2;
        let mut info: rusage_info_v2 = unsafe { std::mem::zeroed() };
        // rusage_info_t = *mut c_void, so &mut info_ptr is *mut *mut c_void.
        let mut info_ptr: *mut libc::c_void = &mut info as *mut _ as *mut libc::c_void;
        let ret = unsafe {
            libc::proc_pid_rusage(
                pid as libc::c_int,
                libc::RUSAGE_INFO_V2,
                &mut info_ptr,
            )
        };
        if ret == 0 {
            return info.ri_resident_size;
        }
        0
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pid;
        0
    }
}

/// Sample the RSS of the current process in bytes.
///
/// On macOS uses the mach `task_info` TASK_BASIC_INFO flavour to read
/// `resident_size`.  Returns 0 on failure and **never panics**.
pub fn sample_process_rss_self() -> u64 {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn task_info(
                target_task: u32,
                flavor: u32,
                task_info_out: *mut u32,
                task_info_count: *mut u32,
            ) -> i32;
            fn mach_task_self() -> u32;
        }
        const TASK_BASIC_INFO: u32 = 5;
        const TASK_BASIC_INFO_COUNT: u32 = 10;
        let mut info = [0u32; 10];
        let mut count = TASK_BASIC_INFO_COUNT;
        let ret = unsafe {
            task_info(
                mach_task_self(),
                TASK_BASIC_INFO,
                info.as_mut_ptr(),
                &mut count,
            )
        };
        if ret == 0 && count >= 2 {
            let lo = info[1] as u64;
            let hi = info[2] as u64;
            return (hi << 32) | lo;
        }
        0
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

// ── MLX memory configuration ───────────────────────────────────────────────

/// Configure MLX Metal active and cache memory limits, then drain the cache.
///
/// This is a safe, top-level helper that wraps the raw
/// [`compute_image::set_mlx_memory_limit`] and
/// [`compute_image::set_mlx_cache_limit`] calls and finishes with a
/// [`compute_image::clear_mlx_cache`] so the new limits take effect
/// immediately.
pub fn configure_mlx_memory_limits(active_limit_bytes: u64, cache_limit_bytes: u64) {
    compute_image::set_mlx_memory_limit(active_limit_bytes);
    compute_image::set_mlx_cache_limit(cache_limit_bytes);
    compute_image::clear_mlx_cache();
}

/// Configure MLX memory limits from a model admission estimate and machine profile.
///
/// Calculates the MLX allocator budget as `usable_bytes - peak_needed`, then
/// splits it into active (50%) and cache (25%) limits.  The remaining 25% is
/// left for transient workspaces and system overhead.
///
/// # Panics
/// Panics when the admission estimate exceeds the machine's usable memory.
pub fn configure_mlx_limits_for_model(
    estimate: &crate::model_runtime::ModelAdmissionEstimate,
    machine: &MachineProfile,
) {
    let available = machine.usable_bytes;
    let needed = estimate.peak_bytes();
    if needed > available {
        panic!(
            "model admission estimate {} exceeds usable memory {}",
            needed, available,
        );
    }
    let mlx_budget = available.saturating_sub(needed);
    let active_limit = mlx_budget / 2;
    let cache_limit = mlx_budget / 4;
    crate::compute_image::set_mlx_memory_limit(active_limit);
    crate::compute_image::set_mlx_cache_limit(cache_limit);
}

// ── MLX memory snapshot ────────────────────────────────────────────────────

/// A point-in-time snapshot of MLX Metal allocator state.
#[derive(Debug, Clone, Copy)]
pub struct MlxMemorySnapshot {
    /// Bytes allocated and active on the Metal device.
    pub active_bytes: u64,
    /// Bytes held in the Metal allocator cache (not yet freed to the OS).
    pub cache_bytes: u64,
    /// Peak active bytes observed so far.
    pub peak_bytes: u64,
}

/// Sample current MLX Metal allocator counters.
///
/// If MLX has not been initialised all fields will be 0 – this is not an
/// error.
pub fn sample_mlx_memory() -> MlxMemorySnapshot {
    MlxMemorySnapshot {
        active_bytes: compute_image::mlx_active_memory_bytes(),
        cache_bytes: compute_image::mlx_cache_memory_bytes(),
        peak_bytes: compute_image::mlx_peak_memory_bytes(),
    }
}

// ── Combined telemetry ─────────────────────────────────────────────────────

/// A unified memory telemetry record pairing process RSS with MLX allocator
/// state at a single instant.
#[derive(Debug, Clone)]
pub struct MemoryTelemetry {
    /// Resident set size of the sampled process.
    pub process_rss: u64,
    /// MLX Metal allocator snapshot.
    pub mlx_snapshot: MlxMemorySnapshot,
    /// Wall-clock timestamp of the sample.
    pub timestamp: Instant,
}

/// Sample process RSS and MLX allocator state in one shot.
pub fn sample_memory_telemetry(pid: u32) -> MemoryTelemetry {
    MemoryTelemetry {
        process_rss: sample_process_rss(pid),
        mlx_snapshot: sample_mlx_memory(),
        timestamp: Instant::now(),
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_profile() {
        let p = detect_machine_profile();
        // On any real macOS machine total physical memory must be > 0.
        #[cfg(target_os = "macos")]
        {
            assert!(p.total_physical_bytes > 0, "total_physical_bytes should be > 0 on macOS");
            assert!(p.usable_bytes > 0, "usable_bytes should be > 0 on macOS");
            assert!(p.usable_bytes <= p.total_physical_bytes, "usable must not exceed total");
            assert!(!p.model.is_empty(), "model string should not be empty on macOS");
            assert!(!p.gpu_family.is_empty(), "gpu_family should not be empty on macOS");
        }
        // On non-macOS we just check the fallback paths produce zero/non-empty.
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(p.total_physical_bytes, 0);
            assert_eq!(p.usable_bytes, 0);
            assert_eq!(p.model, "Unknown");
        }
    }

    #[test]
    fn test_sample_self_rss() {
        let rss = sample_process_rss_self();
        #[cfg(target_os = "macos")]
        {
            // The current process must have some resident pages.
            assert!(rss > 0, "self RSS should be > 0 on macOS (got {rss})");
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(rss, 0);
        }
    }

    #[test]
    fn test_sample_process_rss_pid_zero() {
        // pid 0 (current process) should return sensible results on macOS.
        let rss = sample_process_rss(0);
        #[cfg(target_os = "macos")]
        {
            assert!(rss > 0, "RSS for pid 0 should be > 0 on macOS (got {rss})");
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(rss, 0);
        }
    }

    #[test]
    fn test_sample_process_rss_invalid_pid() {
        // pid 0xFFFFFFF is extremely unlikely to exist → should return 0,
        // not panic.
        let rss = sample_process_rss(0xFFFF_FFFF);
        // On macOS this may or may not be 0 depending on whether the outer
        // platform allows querying arbitrary processes. We just assert no
        // crash.
        let _ = rss;
    }

    #[test]
    fn test_mlx_snapshot_does_not_panic() {
        // MLX may not be initialised, so the snapshot may be all-zero.
        // The important thing is it does not panic.
        let snap = sample_mlx_memory();
        // Values are always valid u64s (they may be 0).
        let _ = snap.active_bytes;
        let _ = snap.cache_bytes;
        let _ = snap.peak_bytes;
    }

    #[test]
    fn test_mlx_snapshot_struct() {
        let snap = sample_mlx_memory();
        // Structural invariant: peak >= active when MLX is initialised.
        // When MLX is *not* initialised all are 0, which trivially satisfies
        // this.
        assert!(
            snap.peak_bytes >= snap.active_bytes,
            "peak ({}) should be >= active ({})",
            snap.peak_bytes,
            snap.active_bytes,
        );
    }

    #[test]
    fn test_memory_telemetry() {
        let t = sample_memory_telemetry(0);
        // telemetry should always produce a valid Instant (it is created on
        // every call).
        let _elapsed = t.timestamp.elapsed();
        // RSS and MLX values are whatever they are – no crash.
        let _ = t.process_rss;
        let _ = t.mlx_snapshot.active_bytes;
    }

    #[test]
    fn test_usable_reserve() {
        // 16 GiB → 14 GiB usable (2 GiB reserve).
        assert_eq!(usable_after_system_reserve(16 * 1024 * 1024 * 1024), 14 * 1024 * 1024 * 1024);
        // 8 GiB → 7 GiB usable (1 GiB reserve).
        assert_eq!(usable_after_system_reserve(8 * 1024 * 1024 * 1024), 7 * 1024 * 1024 * 1024);
        // 32 GiB → 28 GiB usable (4 GiB reserve).
        assert_eq!(usable_after_system_reserve(32 * 1024 * 1024 * 1024), 28 * 1024 * 1024 * 1024);
        // 64 GiB → 56 GiB usable (8 GiB reserve).
        assert_eq!(usable_after_system_reserve(64 * 1024 * 1024 * 1024), 56 * 1024 * 1024 * 1024);
        // Saturating: 0 bytes total → 0 usable.
        assert_eq!(usable_after_system_reserve(0), 0);
    }

    #[test]
    fn test_configure_mlx_limits_does_not_panic() {
        // No crash when setting limits, regardless of MLX init state.
        configure_mlx_memory_limits(2 * 1024 * 1024 * 1024, 512 * 1024 * 1024);
    }
}
