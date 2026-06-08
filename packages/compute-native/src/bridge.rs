//! Zero-copy bridge between Tribunus StorageHandle registry and MLX arrays.
//!
//! MLX arrays created via `mlx_array_new_data_managed` reference externally-owned
//! memory. When MLX releases the array, the destructor callback fires, notifying
//! the JS-side StorageHandle registry to decrement its reference count.
//!
//! ArrayHandle is an opaque integer id that maps to an MLX Array stored in the
//! global ARRAY_REGISTRY. The TypeScript side holds the id and passes it back
//! for operations.

use mlx_rs::{Array, Dtype};
use parking_lot::RwLock;
use std::sync::Arc;

// ── Array Registry ──────────────────────────────────────────────────────────

/// Generation-protected handle identifier.
///
/// Upper 32 bits: generation counter (incremented on slot reuse).
/// Lower 32 bits: slot index into the registry.
///
/// A stale handle (released and whose slot was reused) will fail lookup
/// because its generation won't match the current generation for that slot.
pub type ArrayHandle = u64;

/// The nil/null handle — never allocated, always invalid.
#[allow(dead_code)]
pub const NULL_HANDLE: ArrayHandle = 0;

/// Pack a (slot, generation) pair into a handle.
fn pack_handle(slot: u32, generation: u32) -> ArrayHandle {
    ((generation as u64) << 32) | (slot as u64)
}

/// Unpack a handle into (slot, generation).
fn unpack_handle(handle: ArrayHandle) -> (u32, u32) {
    ((handle & 0xFFFF_FFFF) as u32, (handle >> 32) as u32)
}

struct ArrayEntry {
    array: Array,
    /// Current generation for this slot (incremented on release/reuse).
    generation: u32,
    /// Optional callback invoked when this entry is dropped.
    _on_drop: Option<Box<dyn FnOnce() + Send>>,
}
// SAFETY: ArrayEntry is only accessed under RwLock protection
unsafe impl Send for ArrayEntry {}
unsafe impl Sync for ArrayEntry {}

pub struct ArrayRegistry {
    /// Slots are indexed by slot id (lower 32 bits of handle).
    /// A None value means the slot is free.
    slots: Vec<Option<ArrayEntry>>,
    /// Freelist of released slot indices for reuse.
    freelist: Vec<u32>,
    /// Total handles ever allocated (diagnostic).
    total_allocated: u64,
}

// SAFETY: ArrayRegistry is only accessed under RwLock protection
unsafe impl Send for ArrayRegistry {}
unsafe impl Sync for ArrayRegistry {}
impl ArrayRegistry {
    fn new() -> Self {
        Self {
            // Pre-allocate slot 0 as permanently occupied (NULL_HANDLE guard).
            slots: vec![None],
            freelist: Vec::new(),
            total_allocated: 0,
        }
    }

    pub(crate) fn insert(
        &mut self,
        array: Array,
        on_drop: Option<Box<dyn FnOnce() + Send>>,
    ) -> ArrayHandle {
        let slot = if let Some(reused) = self.freelist.pop() {
            // Reuse a released slot — bump its generation
            let existing = self.slots[reused as usize].take();
            let generation = existing.map(|e| e.generation.wrapping_add(1)).unwrap_or(1);
            self.slots[reused as usize] = Some(ArrayEntry {
                array,
                generation,
                _on_drop: on_drop,
            });
            pack_handle(reused, generation)
        } else {
            // Allocate a new slot
            let slot = self.slots.len() as u32;
            let generation = 1u32;
            self.slots.push(Some(ArrayEntry {
                array,
                generation,
                _on_drop: on_drop,
            }));
            pack_handle(slot, generation)
        };
        self.total_allocated += 1;
        slot
    }

    pub(crate) fn get(&self, handle: ArrayHandle) -> Option<&Array> {
        let (slot, generation) = unpack_handle(handle);
        if slot == 0 {
            return None;
        } // NULL_HANDLE
        self.slots.get(slot as usize).and_then(|entry| {
            entry.as_ref().and_then(|e| {
                if e.generation == generation {
                    Some(&e.array)
                } else {
                    None
                }
            })
        })
    }

    fn remove(&mut self, handle: ArrayHandle) -> Option<Array> {
        let (slot, generation) = unpack_handle(handle);
        if slot == 0 {
            return None;
        }
        let entry = self.slots.get_mut(slot as usize)?;
        match entry.take() {
            Some(e) if e.generation == generation => {
                self.freelist.push(slot);
                Some(e.array)
            }
            other => {
                // Restore the entry if generation didn't match
                *entry = other;
                None
            }
        }
    }

    pub(crate) fn drain(&mut self) {
        self.slots.clear();
        self.slots.push(None); // preserve slot 0 as guard
        self.freelist.clear();
    }
}

lazy_static::lazy_static! {
    pub(crate) static ref ARRAY_REGISTRY: Arc<RwLock<ArrayRegistry>> =
        Arc::new(RwLock::new(ArrayRegistry::new()));
}

// ── Public API ──────────────────────────────────────────────────────────────

/// MLX dtype values matching the Dtype enum variants.
#[derive(Clone, Copy)]
#[allow(dead_code)]
pub enum DtypeId {
    Float32 = 0,
    Float16 = 1,
    Bfloat16 = 2,
    Int32 = 3,
    Int16 = 4,
    Int8 = 5,
    Uint8 = 6,
    Uint16 = 7,
    Uint32 = 8,
    Bool = 9,
}

fn dtype_from_id(id: u32) -> napi::Result<Dtype> {
    match id {
        0 => Ok(Dtype::Float32),
        1 => Ok(Dtype::Float16),
        2 => Ok(Dtype::Bfloat16),
        3 => Ok(Dtype::Int32),
        4 => Ok(Dtype::Int16),
        5 => Ok(Dtype::Int8),
        6 => Ok(Dtype::Uint8),
        7 => Ok(Dtype::Uint16),
        8 => Ok(Dtype::Uint32),
        9 => Ok(Dtype::Bool),
        _ => Err(napi::Error::from_reason(format!(
            "Unknown dtype id: {}",
            id
        ))),
    }
}

/// Create an MLX array from a float32 data buffer (copies into MLX-managed memory).
pub fn create_array_f32(data: &[f32], shape: &[i32]) -> ArrayHandle {
    let array = Array::from_slice(data, shape);
    ARRAY_REGISTRY.write().insert(array, None)
}
pub fn create_array_raw(data: &[u8], shape: &[i32], dtype_id: u32) -> napi::Result<ArrayHandle> {
    let dtype = dtype_from_id(dtype_id)?;
    let array =
        unsafe { Array::from_raw_data(data.as_ptr() as *const std::ffi::c_void, shape, dtype) };
    Ok(ARRAY_REGISTRY.write().insert(array, None))
}

/// Create an MLX array from a scalar float32 value.
pub fn create_scalar_f32(value: f32) -> ArrayHandle {
    let array = Array::from_f32(value);
    ARRAY_REGISTRY.write().insert(array, None)
}

/// Materialize a lazy array (force evaluation of the compute graph).
pub fn array_eval(handle: ArrayHandle) -> napi::Result<()> {
    let registry = ARRAY_REGISTRY.read();
    let array = registry
        .get(handle)
        .ok_or_else(|| napi::Error::from_reason(format!("Array not found: {}", handle)))?;
    array
        .eval()
        .map_err(|e| napi::Error::from_reason(format!("MLX eval error: {:?}", e)))
}

/// Get the shape of an array.
pub fn array_shape(handle: ArrayHandle) -> napi::Result<Vec<i32>> {
    let registry = ARRAY_REGISTRY.read();
    let array = registry
        .get(handle)
        .ok_or_else(|| napi::Error::from_reason(format!("Array not found: {}", handle)))?;
    Ok(array.shape().to_vec())
}

/// Get the number of elements in an array.
pub fn array_size(handle: ArrayHandle) -> napi::Result<usize> {
    let registry = ARRAY_REGISTRY.read();
    let array = registry
        .get(handle)
        .ok_or_else(|| napi::Error::from_reason(format!("Array not found: {}", handle)))?;
    Ok(array.size())
}

/// Get the number of bytes in an array.
pub fn array_nbytes(handle: ArrayHandle) -> napi::Result<usize> {
    let registry = ARRAY_REGISTRY.read();
    let array = registry
        .get(handle)
        .ok_or_else(|| napi::Error::from_reason(format!("Array not found: {}", handle)))?;
    Ok(array.nbytes())
}

/// Read array data as f32 values (triggers evaluation, copies to output buffer).
pub fn array_data_f32(handle: ArrayHandle, out: &mut [u8]) -> napi::Result<usize> {
    let registry = ARRAY_REGISTRY.read();
    let array = registry
        .get(handle)
        .ok_or_else(|| napi::Error::from_reason(format!("Array not found: {}", handle)))?;

    let data = array
        .try_as_slice::<f32>()
        .map_err(|e| napi::Error::from_reason(format!("Failed to read array data: {:?}", e)))?;

    let byte_count = (data.len() * 4).min(out.len());
    let f32_count = byte_count / 4;
    let src_bytes = unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, byte_count) };
    out[..byte_count].copy_from_slice(src_bytes);
    Ok(f32_count)
}

/// Free an array handle, releasing MLX resources.
pub fn free_array(handle: ArrayHandle) -> napi::Result<()> {
    ARRAY_REGISTRY.write().remove(handle);
    Ok(())
}

/// Release all arrays (teardown).
pub fn drain_arrays() {
    ARRAY_REGISTRY.write().drain();
}

/// Get the number of active array handles (diagnostic).
pub fn handle_count() -> usize {
    ARRAY_REGISTRY
        .read()
        .slots
        .iter()
        .filter(|s| s.is_some())
        .count()
}

// ── Compute Operations ──────────────────────────────────────────────────────

/// Matrix multiplication: c = a @ b
pub fn matmul(a_handle: ArrayHandle, b_handle: ArrayHandle) -> napi::Result<ArrayHandle> {
    let registry = ARRAY_REGISTRY.read();
    let a = registry
        .get(a_handle)
        .ok_or_else(|| napi::Error::from_reason("matmul: a not found"))?;
    let b = registry
        .get(b_handle)
        .ok_or_else(|| napi::Error::from_reason("matmul: b not found"))?;

    let result = a
        .matmul(b)
        .map_err(|e| napi::Error::from_reason(format!("matmul error: {:?}", e)))?;
    drop(registry);

    Ok(ARRAY_REGISTRY.write().insert(result, None))
}

/// Element-wise addition: c = a + b
pub fn add(a_handle: ArrayHandle, b_handle: ArrayHandle) -> napi::Result<ArrayHandle> {
    let registry = ARRAY_REGISTRY.read();
    let a = registry
        .get(a_handle)
        .ok_or_else(|| napi::Error::from_reason("add: a not found"))?;
    let b = registry
        .get(b_handle)
        .ok_or_else(|| napi::Error::from_reason("add: b not found"))?;
    let result = a
        .add(b)
        .map_err(|e| napi::Error::from_reason(format!("add error: {:?}", e)))?;
    drop(registry);
    Ok(ARRAY_REGISTRY.write().insert(result, None))
}

/// Element-wise multiplication: c = a * b
pub fn multiply(a_handle: ArrayHandle, b_handle: ArrayHandle) -> napi::Result<ArrayHandle> {
    let registry = ARRAY_REGISTRY.read();
    let a = registry
        .get(a_handle)
        .ok_or_else(|| napi::Error::from_reason("multiply: a not found"))?;
    let b = registry
        .get(b_handle)
        .ok_or_else(|| napi::Error::from_reason("multiply: b not found"))?;
    let result = a
        .multiply(b)
        .map_err(|e| napi::Error::from_reason(format!("multiply error: {:?}", e)))?;
    drop(registry);
    Ok(ARRAY_REGISTRY.write().insert(result, None))
}

// ── Device Detection ────────────────────────────────────────────────────────

/// Information about a detected compute backend.
#[derive(serde::Serialize)]
pub struct BackendInfo {
    pub name: String,
    pub available: bool,
    pub device_name: String,
}

/// Detect default device.
pub fn detect_default_device() -> BackendInfo {
    let device = mlx_rs::Device::try_default().ok();
    let available = device.is_some();
    let device_name = device
        .map(|d| format!("{}", d))
        .unwrap_or_else(|| "unavailable".into());
    BackendInfo {
        name: "metal".into(),
        available,
        device_name,
    }
}
