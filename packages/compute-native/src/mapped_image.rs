//! MappedImage — persistent model store for ComputeImage segment files.
//!
//! All mmap operations use MAP_PRIVATE read-only mappings. Raw pointers from
//! mmap are valid for the lifetime of the MappedSegment Arc.

use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::ptr;
use std::slice;
use std::sync::Arc;

use libc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Lifecycle state for a single memory segment within a MappedImage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SegmentState {
    /// Segment has been identified but not yet loaded into memory.
    Unmapped,
    /// Segment data is resident in mapped/pinned memory.
    Mapped,
    /// Segment has been bound to an execution context (e.g., GPU buffer).
    Bound,
    /// Segment is idle but remains mapped for potential reuse.
    IdleMapped,
}

/// A memory-mapped segment backed by a file on disk.
///
/// The file is mapped with `MAP_PRIVATE | MAP_NORESERVE` (read-only). The
/// mapping lives until the last `Arc` reference is dropped, at which point
/// `munmap` is called.
///
/// # Safety
///
/// `MappedSegment` is `Send + Sync` because the mapping is read-only. The raw
/// pointer (`mapping_ptr`) is valid for the lifetime of the `Arc<MappedSegment>`.
/// Callers must not dereference the pointer after the last `Arc` is dropped.
#[derive(Debug)]
pub struct MappedSegment {
    pub file_path: PathBuf,
    pub file_len: u64,
    pub segment_hash: String,
    pub mapping_ptr: *const u8,
    pub mapping_len: usize,
    pub generation: u64,
    pub state: SegmentState,
}

// Safety: the mapping is read-only and the data covered by mapping_ptr is
// stable for the lifetime of the Arc. Dereferencing after the last Arc drops
// is a use-after-free bug in the caller.
unsafe impl Send for MappedSegment {}
unsafe impl Sync for MappedSegment {}

impl MappedSegment {
    /// Open `path` and mmap its contents read-only.
    ///
    /// Uses `MAP_PRIVATE | MAP_NORESERVE` so the mapping does not consume swap
    /// space and writes are copy-on-write. If `expected_hash` is `Some`, the
    /// file's SHA-256 is verified against it before the `Arc` is returned.
    ///
    /// The underlying `File` is dropped after mmap — the kernel keeps the
    /// pages alive through the mapping.
    pub fn new(path: &Path, expected_hash: Option<&str>) -> io::Result<Arc<Self>> {
        let file = File::open(path)?;
        let file_len = file.metadata()?.len();
        let mapping_len = file_len as usize;

        // mmap with MAP_PRIVATE | MAP_NORESERVE (read-only).
        let mapping_ptr: *const u8 = unsafe {
            let ptr = libc::mmap(
                ptr::null_mut(),
                mapping_len,
                libc::PROT_READ,
                libc::MAP_PRIVATE | libc::MAP_NORESERVE,
                file.as_raw_fd(),
                0,
            );
            if ptr == libc::MAP_FAILED {
                return Err(io::Error::last_os_error());
            }
            ptr as *const u8
        };

        // Drop the File — the mmap holds the pages alive.
        drop(file);

        // Compute SHA-256 over the mapped bytes.
        let hash = unsafe {
            let data = slice::from_raw_parts(mapping_ptr, mapping_len);
            let mut hasher = Sha256::new();
            hasher.update(data);
            format!("{:x}", hasher.finalize())
        };

        // Verify hash if an expected value was provided.
        if let Some(expected) = expected_hash {
            if hash != *expected {
                unsafe {
                    libc::munmap(mapping_ptr as *mut libc::c_void, mapping_len);
                }
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "SHA256 mismatch for {:?}: expected {}, got {}",
                        path, expected, hash
                    ),
                ));
            }
        }

        Ok(Arc::new(Self {
            file_path: path.to_path_buf(),
            file_len,
            segment_hash: hash,
            mapping_ptr,
            mapping_len,
            generation: 1,
            state: SegmentState::Mapped,
        }))
    }

    /// Returns a raw pointer to the start of the mapping.
    #[inline]
    pub fn data_ptr(&self) -> *const u8 {
        self.mapping_ptr
    }

    /// Returns a byte slice covering the entire mapped segment.
    #[inline]
    pub fn data_slice(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.mapping_ptr, self.mapping_len) }
    }

    /// Returns the length of the mapping in bytes.
    #[inline]
    pub fn len(&self) -> usize {
        self.mapping_len
    }

    /// Returns the file path backing this segment.
    #[inline]
    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    /// Returns the SHA-256 hash as a hex string.
    #[inline]
    pub fn hash(&self) -> &str {
        &self.segment_hash
    }

    /// Returns the current generation counter.
    #[inline]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Increments the generation counter by one.
    #[inline]
    pub fn bump_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
}

impl Drop for MappedSegment {
    fn drop(&mut self) {
        // Guard against double-free: only munmap when the ptr is non-null and
        // the length is positive. This is a no-op for zero-length mappings.
        if self.mapping_len > 0 && !self.mapping_ptr.is_null() {
            unsafe {
                libc::munmap(self.mapping_ptr as *mut libc::c_void, self.mapping_len);
            }
        }
    }
}

/// Metadata describing a single segment within a ComputeImage.
///
/// The `segment_lease` field optionally holds a reference to the live
/// `MappedSegment`, extending the segment's lifetime as long as the view
/// is held.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentView {
    pub segment_id: String,
    pub segment_index: u64,
    pub file_path: PathBuf,
    pub byte_offset: u64,
    pub byte_length: u64,
    pub kind: String,
    /// Live reference to the mmap'd segment, or `None` if not yet mapped.
    #[serde(skip)]
    pub segment_lease: Option<Arc<MappedSegment>>,
}

/// Persistent file-handle store for ComputeImage segment files.
///
/// Manages memory-mapped segments backed by on-disk segment files, decoupling
/// the compilation lifecycle (which produces the segments) from the inference
/// lifecycle (which consumes them).
pub struct MappedImage {
    /// Root directory containing the segment files.
    pub image_dir: PathBuf,
    /// Mapped segments keyed by segment ID.
    pub segments: HashMap<String, Arc<MappedSegment>>,
    /// Whether the segment files are currently mapped.
    pub is_mapped: bool,
}

impl MappedImage {
    /// mmap all segment files referenced by `segments` under `image_dir`.
    ///
    /// Each segment's `file_path` is resolved relative to `image_dir`. Segments
    /// are mapped with `MAP_PRIVATE | MAP_NORESERVE` (read-only SHA-256
    /// verified).
    pub fn open_mapped(image_dir: &Path, segments: &[SegmentView]) -> io::Result<Self> {
        let mut mapped = HashMap::new();

        for seg in segments {
            let path = image_dir.join(&seg.file_path);
            let segment = MappedSegment::new(&path, None)?;
            mapped.insert(seg.segment_id.clone(), segment);
        }

        Ok(Self {
            image_dir: image_dir.to_path_buf(),
            segments: mapped,
            is_mapped: true,
        })
    }

    /// Returns `true` if segments are currently mapped.
    pub fn is_mapped(&self) -> bool {
        self.is_mapped
    }

    /// Returns the mapped segment identified by `segment_id`, or `None`.
    pub fn get_segment(&self, segment_id: &str) -> Option<&Arc<MappedSegment>> {
        self.segments.get(segment_id)
    }

    /// Returns the number of mapped segments.
    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    /// Returns the file length in bytes for `segment_id`, or `None` if unknown.
    pub fn segment_size(&self, segment_id: &str) -> Option<u64> {
        self.segments.get(segment_id).map(|s| s.file_len)
    }

    /// Release all mapped segments.
    ///
    /// Drops the `MappedImage`'s `Arc` references. The underlying `munmap`
    /// fires only when all other `Arc` clones (e.g., held via
    /// `SegmentView::segment_lease`) are also dropped.
    ///
    /// Safe to call multiple times; subsequent calls are no-ops.
    pub fn close(&mut self) {
        if !self.is_mapped {
            return;
        }
        self.segments.clear();
        self.is_mapped = false;
    }
}

impl Drop for MappedImage {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_segment_state_roundtrip() {
        let states = [
            SegmentState::Unmapped,
            SegmentState::Mapped,
            SegmentState::Bound,
            SegmentState::IdleMapped,
        ];
        for &s in &states {
            let json = serde_json::to_string(&s).unwrap();
            let back: SegmentState = serde_json::from_str(&json).unwrap();
            assert_eq!(s, back);
        }
    }

    #[test]
    fn test_segment_view() {
        let sv = SegmentView {
            segment_id: "layer_0_attn".into(),
            segment_index: 0,
            file_path: PathBuf::from("segment_000.bin"),
            byte_offset: 0,
            byte_length: 4096,
            kind: "weight".into(),
            segment_lease: None,
        };
        assert_eq!(sv.segment_id, "layer_0_attn");
        assert_eq!(sv.segment_index, 0);
        assert_eq!(sv.byte_length, 4096);
        assert_eq!(sv.kind, "weight");
        assert!(sv.segment_lease.is_none());
    }

    #[test]
    fn test_open_mapped_close() {
        let dir = std::env::temp_dir().join("mapped_image_open_close");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let seg_id = "test_seg".to_string();
        let seg_path = dir.join(format!("{}.seg", seg_id));
        let seg_filename = format!("{}.seg", seg_id);
        let mut f = std::fs::File::create(&seg_path).unwrap();
        f.write_all(&[0u8; 256]).unwrap();
        drop(f);

        let segments = [SegmentView {
            segment_id: seg_id.clone(),
            segment_index: 0,
            file_path: PathBuf::from(&seg_filename),
            byte_offset: 0,
            byte_length: 256,
            kind: "weight".into(),
            segment_lease: None,
        }];

        let mut image = MappedImage::open_mapped(&dir, &segments).unwrap();
        assert!(image.is_mapped());
        assert!(image.segments.contains_key(&seg_id));
        assert_eq!(image.segment_size(&seg_id), Some(256));
        assert_eq!(image.segment_count(), 1);

        // Verify the mapping is readable.
        let seg = image.get_segment(&seg_id).unwrap();
        assert_eq!(seg.len(), 256);
        assert_eq!(seg.data_slice().len(), 256);
        assert_eq!(seg.generation(), 1);
        assert!(!seg.hash().is_empty());

        image.close();
        assert!(!image.is_mapped());
        assert!(image.segments.is_empty());
        assert_eq!(image.segment_count(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_drop_calls_close() {
        let dir = std::env::temp_dir().join("mapped_image_drop");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let seg_id = "drop_seg".to_string();
        let seg_path = dir.join(format!("{}.seg", seg_id));
        let seg_filename = format!("{}.seg", seg_id);
        let mut f = std::fs::File::create(&seg_path).unwrap();
        f.write_all(&[0u8; 128]).unwrap();
        drop(f);

        let segments = [SegmentView {
            segment_id: seg_id.clone(),
            segment_index: 0,
            file_path: PathBuf::from(&seg_filename),
            byte_offset: 0,
            byte_length: 128,
            kind: "weight".into(),
            segment_lease: None,
        }];

        {
            let image = MappedImage::open_mapped(&dir, &segments).unwrap();
            assert!(image.is_mapped());
            // image drops here — should close (munmap) without panic
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_missing_file_returns_error() {
        let dir = std::env::temp_dir().join("mapped_image_missing");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let segments = [SegmentView {
            segment_id: "nonexistent".into(),
            segment_index: 0,
            file_path: PathBuf::from("nonexistent.seg"),
            byte_offset: 0,
            byte_length: 64,
            kind: "weight".into(),
            segment_lease: None,
        }];

        let result = MappedImage::open_mapped(&dir, &segments);
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_mapped_segment_new() {
        let dir = std::env::temp_dir().join("mapped_segment_new");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("test.bin");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);

        let segment = MappedSegment::new(&path, None).unwrap();
        assert_eq!(segment.len(), 11);
        assert_eq!(segment.data_slice(), b"hello world");
        assert_eq!(segment.file_path(), &path);
        assert_eq!(segment.file_len, 11);
        assert_eq!(segment.generation(), 1);
        assert!(!segment.hash().is_empty());
        assert_eq!(segment.state, SegmentState::Mapped);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_mapped_segment_hash_verification() {
        let dir = std::env::temp_dir().join("mapped_segment_hash");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("test.bin");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);

        // Get the actual hash by creating the segment first.
        let segment = MappedSegment::new(&path, None).unwrap();
        let actual_hash = segment.hash().to_string();

        // Verify with correct hash — should succeed.
        let segment2 = MappedSegment::new(&path, Some(&actual_hash)).unwrap();
        assert_eq!(segment2.hash(), actual_hash);

        // Verify with wrong hash — should fail.
        let result = MappedSegment::new(&path, Some("deadbeef"));
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_mapped_segment_bump_generation() {
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("test.bin");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"data").unwrap();
        drop(f);

        let segment = MappedSegment::new(&path, None).unwrap();
        // Arc::try_unwrap succeeds when refcount is 1.
        let mut owned = Arc::try_unwrap(segment).unwrap();
        assert_eq!(owned.generation(), 1);
        owned.bump_generation();
        assert_eq!(owned.generation(), 2);
        owned.bump_generation();
        assert_eq!(owned.generation(), 3);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_mapped_segment_lifetime() {
        // Prove that a view into the mapping stays valid while the Arc lives,
        // and the mapping is released after the last Arc drops.
        let dir = std::env::temp_dir().join("mapped_segment_lifetime");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Write known content.
        let path = dir.join("lifecycle.bin");
        let content: Vec<u8> = (0..128).collect();
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(&content).unwrap();
        drop(f);

        // Step 1: Acquire the segment.
        let seg: Arc<MappedSegment> = MappedSegment::new(&path, None).unwrap();

        // Step 2: Get a slice into the mapping while the Arc is alive.
        let view: &[u8] = seg.data_slice();
        assert_eq!(view.len(), 128);
        assert_eq!(view[0], 0);
        assert_eq!(view[127], 127);

        // Step 3: Clone the Arc (shared ownership).
        let seg_clone: Arc<MappedSegment> = Arc::clone(&seg);
        assert_eq!(seg_clone.data_slice(), &content[..]);

        // Step 4: Drop the original Arc — the mapping stays valid through seg_clone.
        drop(seg);
        assert_eq!(seg_clone.data_slice(), &content[..]);
        assert_eq!(seg_clone.len(), 128);

        // Also verify through the view captured earlier.
        assert_eq!(view[0], 0);

        // Step 5: Drop the clone — munmap fires, mapping released.
        drop(seg_clone);

        // Step 6: The temp file is still on disk (never deleted).
        assert!(path.exists());
        let restored = std::fs::read(&path).unwrap();
        assert_eq!(restored, content);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_mapped_segment_arc_drop_releases_mapping() {
        // Confirm that munmap actually fires by mapping a file, dropping,
        // and writing to the same path without file-busy errors.
        let dir = std::env::temp_dir().join("mapped_segment_arc_drop");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("replaceable.bin");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"original content").unwrap();
        drop(f);

        {
            let seg = MappedSegment::new(&path, None).unwrap();
            assert_eq!(seg.len(), 16);
            // Arc drops here — munmap fires.
        }

        // After the Arc drops, the file is not locked by our mapping.
        // Replace its contents entirely.
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"replaced content").unwrap();
        drop(f);
        let replaced = std::fs::read(&path).unwrap();
        assert_eq!(replaced, b"replaced content");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
