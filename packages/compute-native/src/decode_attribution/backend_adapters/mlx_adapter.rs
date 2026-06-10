//! MLX backend adapter for the Three-Backend Decode Attribution Gate.
//!
//! Wraps `mlx_rs` matmul with forced evaluation before the timer stops.
//! MLX uses lazy evaluation — array operations build a graph that is only
//! executed when `.eval()` is called or values are read. Every timed
//! execution in this adapter calls `.eval()` explicitly to ensure the
//! elapsed time reflects actual computation, not graph construction.
//!
//! Only `matmul` is wired in this mission. All other graph families report
//! `NotImplemented`.

use std::time::Instant;

use super::BackendSupportStatus;

// ── Support classification ─────────────────────────────────────────────────

/// Return the support status for a given graph family name.
///
/// - `"matmul"` → `Supported` (the only family wired in this mission)
/// - All other families → `NotImplemented`
pub fn support_status(family_name: &str) -> BackendSupportStatus {
    match family_name {
        "matmul" => BackendSupportStatus::Supported,
        _ => BackendSupportStatus::NotImplemented,
    }
}

// ── Device detection ───────────────────────────────────────────────────────

/// Detect the default MLX device and return `(device_name, device_kind)`.
///
/// `device_kind` is `"gpu"` or `"cpu"` (or `"unknown"` if no device available).
pub fn detect_device() -> (String, String) {
    match mlx_rs::Device::try_default().ok() {
        Some(device) => {
            let device_name = format!("{}", device);
            let device_kind = if device == mlx_rs::Device::gpu() {
                "gpu"
            } else if device == mlx_rs::Device::cpu() {
                "cpu"
            } else {
                "unknown"
            };
            (device_name, device_kind.to_string())
        }
        None => ("unknown".to_string(), "unknown".to_string()),
    }
}

// ── Array preparation ──────────────────────────────────────────────────────

/// Prepare MLX arrays for a matmul of shape `[m, k] × [k, n]`.
///
/// Creates three `mlx_rs::Array` values from the provided slices:
/// - `input` — shape `[m, k]`
/// - `weight` — shape `[k, n]`
/// - `output` — shape `[m, n]`, zero-filled (convention placeholder; MLX
///   `matmul` returns a new Array rather than writing into a pre-allocated
///   buffer, so this array is kept alive for interface consistency)
///
/// Returns the three arrays so callers can keep them alive across repeated
/// warmup/steady iterations without re-allocating.
pub fn prepare_matmul(
    input: &[f32],
    weight: &[f32],
    m: i32,
    k: i32,
    n: i32,
) -> Result<(mlx_rs::Array, mlx_rs::Array, mlx_rs::Array), String> {
    let input_arr = mlx_rs::Array::from_slice(input, &[m, k]);
    let weight_arr = mlx_rs::Array::from_slice(weight, &[k, n]);
    let output_len = (m * n) as usize;
    let output_data = vec![0.0f32; output_len];
    let output_arr = mlx_rs::Array::from_slice(&output_data, &[m, n]);
    Ok((input_arr, weight_arr, output_arr))
}

// ── Matmul execution ───────────────────────────────────────────────────────

/// Run a single matmul on MLX arrays with forced evaluation.
///
/// Timing sequence:
/// 1. `input_arr.matmul(weight_arr)` — builds the lazy graph node
/// 2. `.eval()` — forces GPU/CPU computation to complete
/// 3. `.try_as_slice::<f32>()` — reads output to guarantee full
///    synchronization before the timer stops
///
/// Returns elapsed wall-clock time in nanoseconds (includes everything
/// above — graph construction, evaluation, and readback).
pub fn run_matmul(
    input_arr: &mlx_rs::Array,
    weight_arr: &mlx_rs::Array,
    _output_arr: &mlx_rs::Array,
    _m: i32,
    _n: i32,
) -> Result<u64, String> {
    let start = Instant::now();

    // 1. Matmul (lazy — constructs the graph node, no computation yet).
    let result = input_arr
        .matmul(weight_arr)
        .map_err(|e| format!("mlx matmul failed: {:?}", e))?;

    // 2. Force computation.
    result
        .eval()
        .map_err(|e| format!("mlx eval failed: {:?}", e))?;

    // 3. Read output to guarantee the computation is fully materialized
    //    before the timer stops. try_as_slice implies synchronization.
    let _output = result
        .try_as_slice::<f32>()
        .map_err(|e| format!("mlx read output failed: {:?}", e))?;

    let elapsed_ns = start.elapsed().as_nanos() as u64;
    Ok(elapsed_ns)
}
