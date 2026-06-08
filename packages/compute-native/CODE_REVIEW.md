# Tribunus Compute Kernel — API Alignment Review

**Date:** 2026-06-07
**Status:** ✅ Aligned with mlx-rs v0.21.2, napi-rs v3.9.0, safetensors v0.5

## Changes Made

### bridge.rs
- `array.as_slice::<f32>()` → `array.try_as_slice::<f32>()` (returns `Result`, no panic)
- `Array::from_f32()` → `Array::from_float()` (v0.21 API name)
- `Device::default()` → `Device::try_default().ok()` with graceful fallback
- Added `unsafe impl Send + Sync` for `ArrayEntry` and `ArrayRegistry` (required by `lazy_static`)
- Made `ArrayRegistry::get` `pub(crate)` for gemma.rs access
- Added `#[allow(dead_code)]` on public API types only used externally

### gemma.rs
- `Result<Array, mlx_rs::error::Error>` → `MlxResult<Array>` (v0.21 uses `Exception`, not `Error` type alias)
- `.transpose()` (0-arg) → `ops::transpose_all(&array)?` (v0.21 requires axes)
- `.transpose_axes(&[axes])` → `ops::transpose(&array, &[axes])?` (free function)
- `.mean_axes(axes, keep)` → `ops::mean(&array, axes, keep)?` (free function)
- `.concat(&other, axis)` → `ops::concatenate(&[&a, &b], axis)?` (free function)
- `.repeat(&[repeats])` → `ops::tile(&array, &[repeats])?` (tile is correct for per-axis broadcast)
- `.silu()` → `mlx_rs::nn::silu(&array)?` (free function from nn module)
- `.softmax(axis, None)` → `ops::softmax(&array, &[axis], None)?` (free function, axes required)
- `.cos()` / `.sin()` / `.rsqrt()` → `ops::cos(&array)?` / `ops::sin(&array)?` / `ops::rsqrt(&array)?`
- `.multiply_f32(x)` → `.multiply(&Array::from_float(x))?`
- `.divide_f32(x)` → `.divide(&Array::from_float(x))?`
- `.add_f32(x)` → `.add(&Array::from_float(x))?`
- `.astype(Dtype)` → `.as_dtype(Dtype)` (correct method name)
- `.argmax(axis, keep)` → `ops::indexing::argmax(&array, axis, keep)?`
- `.take(indices, axis)` → `ops::indexing::take(&array, indices, axis)?`
- `.slice(...)` → `.index((ranges,))` via `IndexOp` trait
- `mlx_rs::error::Error::msg(...)` → `mlx_rs::error::Exception::custom(...)` 
- `WeightMap::get` returns owned `Array` (clone) instead of `&Array` to avoid RwLock borrow escape
- Added `napi_to_mlx` helper to convert `napi::Error` → `Exception` at weight lookup sites
- `config` clone in `GemmaModel::new` to avoid move-after-use

### loader.rs
- `mlx_rs::safetensors::load_file()` (doesn't exist in v0.21.2) → direct `safetensors::SafeTensors::deserialize()` + `Array::try_from(TensorView)`
- `inspect_safetensors` uses header-only parsing via safetensors crate (no tensor data loaded)
- Added `safetensors = "0.5"` to Cargo.toml as direct dependency

### lib.rs
- `u64` napi parameters → `i64` (napi-rs v3 doesn't impl `FromNapiValue` for `u64`)
- `array_data_f32` uses `Buffer` with `mut` for output (napi-rs v3 borrow semantics)
- Added `mlx_rs::ops::indexing::IndexOp` import for `.index()` calls
- Added `ops::indexing::argmax` for gemma_sample_greedy

### index.d.ts
- Handle types changed from `bigint`/`number` → unified `ArrayHandle = number`

## Verified API Surface (v0.21.2)

These methods/functions ARE correct and verified by compilation:

**Array methods (via `#[default_device]` on impl):**
- `.shape()`, `.size()`, `.nbytes()`, `.ndim()`, `.dtype()`, `.eval()`
- `.matmul(&other)`, `.add(&other)`, `.multiply(&other)`, `.subtract(&other)`, `.divide(&other)`
- `.reshape(&shape)`, `.clone()`, `.as_dtype(Dtype)`, `.try_as_slice::<T>()`, `.item::<T>()`

**Free functions (via `#[default_device]` on fn):**
- `ops::transpose_all(&a)`, `ops::transpose(&a, &axes)`
- `ops::concatenate(&[arrays], axis)`, `ops::tile(&a, &reps)`
- `ops::mean(&a, axes, keep)`, `ops::softmax(&a, &axes, precise)`
- `ops::cos(&a)`, `ops::sin(&a)`, `ops::rsqrt(&a)`
- `ops::indexing::take(&a, indices, axis)`, `ops::indexing::argmax(&a, axis, keep)`
- `mlx_rs::nn::silu(&a)`

**Type exports:**
- `mlx_rs::error::Result<T>` (alias for `Result<T, Exception>`)
- `mlx_rs::error::Exception::custom(msg)`
- `Array::from_float(val)`, `Array::from_slice(data, shape)`, `Array::from_raw_data(ptr, shape, dtype)`
