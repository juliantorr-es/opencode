//! MappedImage — persistent model store for ComputeImage segment files.
//!
//! Separates compilation from inference lifecycle by managing open file
//! handles to execution-ordered segment files, providing segment-level
//! metadata and lifecycle tracking.

use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Lifecycle state for a single memory segment within a MappedImage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SegmentState {
    /// Segment has been identified but not yet loaded into memory.
    Unmapped,
    /// Segment data is resident in mapped/pinned memory.
    Mapped,
    /// Prefault has been requested to warm up memory mappings.
    PrefaultRequested,
    /// Segment has been bound to an execution context (e.g., GPU buffer).
    Bound,
    /// Segment is actively being transferred or computed upon.
    InFlight,
    /// Segment is eligible for retirement / unmapping.
    Retirable,
    /// Segment is idle but remains mapped for potential reuse.
    IdleMapped,
}

/// Metadata describing a single segment within a ComputeImage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentView {
    pub segment_id: String,
    pub byte_size: u64,
    pub filename: String,
    pub state: SegmentState,
}

/// Persistent file-handle store for ComputeImage segment files.
///
/// Manages open `File` handles to on-disk segment files, decoupling the
/// compilation lifecycle (which produces the segments) from the inference
/// lifecycle (which consumes them).
pub struct MappedImage {
    /// Root directory containing the segment files.
    pub image_dir: PathBuf,
    /// Open file handles keyed by segment ID.
    pub segment_files: HashMap<String, File>,
    /// Cached segment sizes in bytes, keyed by segment ID.
    pub segment_sizes: HashMap<String, u64>,
    /// Whether the segment files are currently mapped (opened).
    pub is_mapped: bool,
}

impl MappedImage {
    /// Open all segment files referenced by `segments` under `image_dir`.
    /// Uses each segment's `filename` field to locate the file.
    pub fn open(image_dir: &Path, segments: &[SegmentView]) -> io::Result<Self> {
        let mut segment_files = HashMap::new();
        let mut segment_sizes = HashMap::new();

        for seg in segments {
            let path = image_dir.join(&seg.filename);
            let file = File::open(&path)?;
            segment_sizes.insert(seg.segment_id.clone(), seg.byte_size);
            segment_files.insert(seg.segment_id.clone(), file);
        }

        Ok(Self {
            image_dir: image_dir.to_path_buf(),
            segment_files,
            segment_sizes,
            is_mapped: true,
        })
    }

    /// Returns `true` if all segment files are currently mapped (opened).
    pub fn is_mapped(&self) -> bool {
        self.is_mapped
    }

    /// Returns the cached byte size for `segment_id`, or `None` if unknown.
    pub fn segment_size(&self, segment_id: &str) -> Option<u64> {
        self.segment_sizes.get(segment_id).copied()
    }

    /// Close all open segment file handles and mark as unmapped.
    ///
    /// This is safe to call multiple times; subsequent calls are no-ops.
    pub fn close(&mut self) {
        if !self.is_mapped {
            return;
        }
        self.segment_files.clear();
        self.segment_sizes.clear();
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
            SegmentState::PrefaultRequested,
            SegmentState::Bound,
            SegmentState::InFlight,
            SegmentState::Retirable,
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
            byte_size: 4096,
            filename: "segment_000.bin".into(),
            state: SegmentState::Mapped,
        };
        assert_eq!(sv.segment_id, "layer_0_attn");
        assert_eq!(sv.byte_size, 4096);
        assert_eq!(sv.state, SegmentState::Mapped);
    }

    #[test]
    fn test_open_close() {
        let dir = std::env::temp_dir().join("mapped_image_test_open_close");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Create a fake segment file.
        let seg_id = "test_seg".to_string();
        let seg_path = dir.join(format!("{}.seg", seg_id));
        let seg_filename = format!("{}.seg", seg_id);
        let mut f = std::fs::File::create(&seg_path).unwrap();
        f.write_all(&[0u8; 256]).unwrap();
        drop(f);

        let segments = [SegmentView {
            segment_id: seg_id.clone(),
            byte_size: 256,
            filename: seg_filename.clone(),
            state: SegmentState::Unmapped,
        }];

        let mut image = MappedImage::open(&dir, &segments).unwrap();
        assert!(image.is_mapped());
        assert!(image.segment_files.contains_key(&seg_id));
        assert_eq!(image.segment_size(&seg_id), Some(256));

        image.close();
        assert!(!image.is_mapped());
        assert!(image.segment_files.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_drop_calls_close() {
        let dir = std::env::temp_dir().join("mapped_image_test_drop");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let seg_id = "drop_seg".to_string();
        let seg_path = dir.join(format!("{}.seg", seg_id));
        let mut f = std::fs::File::create(&seg_path).unwrap();
        f.write_all(&[0u8; 128]).unwrap();
        drop(f);

        let segments = [SegmentView {
            segment_id: seg_id.clone(),
            byte_size: 128,
            filename: format!("{}.seg", seg_id),
            state: SegmentState::Unmapped,
        }];

        {
            let image = MappedImage::open(&dir, &segments).unwrap();
            assert!(image.is_mapped());
            // image drops here — should close without panic
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_missing_file_returns_error() {
        let dir = std::env::temp_dir().join("mapped_image_test_missing");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let segments = [SegmentView {
            segment_id: "nonexistent".into(),
            byte_size: 64,
            filename: "nonexistent.seg".into(),
            state: SegmentState::Unmapped,
        }];

        let result = MappedImage::open(&dir, &segments);
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
