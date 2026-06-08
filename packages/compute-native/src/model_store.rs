//! Persistent model store for ComputeImage installation.
//!
//! Separates compilation from inference lifecycle.  Every installed model
//! carries a seal that records per-segment SHA-256 hashes, file sizes, the
//! originating compiler version, and an installation timestamp so the
//! runtime can verify integrity before loading.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Metadata record for a single installed model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledModel {
    pub image_hash: String,
    pub source_identity: String,
    pub installed_at: String, // ISO-8601
}

/// Integrity seal persisted alongside the installed model.
///
/// `segment_hashes` maps relative file paths to their hex-encoded SHA-256
/// digests as recorded at install time.  `file_sizes` records the byte count
/// for each file so `verify_seal` can detect both content and truncation
/// corruption without re-reading every byte on every check.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallationSeal {
    pub image_hash: String,
    pub segment_hashes: HashMap<String, String>,
    pub file_sizes: HashMap<String, u64>,
    pub installed_at_ms: u64,
    pub compiler_version: String,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const DEFAULT_STORE_SUFFIX: &str = ".tribunus/models";

/// Persistent model store rooted at a local directory.
///
/// Each installed model lives in a subdirectory named by its `image_hash`.
/// Within that directory:
///   * `installed.json`  — `InstalledModel` metadata
///   * `seal.json`       — `InstallationSeal` for integrity verification
///   * `segments/`       — the actual model segment files
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelStore {
    pub root_dir: PathBuf,
}

impl ModelStore {
    /// Create a store at the default path (`~/.tribunus/models/`).
    pub fn default_path() -> PathBuf {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(DEFAULT_STORE_SUFFIX)
    }

    /// Open or create the store at `root_dir`.
    pub fn open<P: Into<PathBuf>>(root_dir: P) -> std::io::Result<Self> {
        let root_dir = root_dir.into();
        fs::create_dir_all(&root_dir)?;
        Ok(Self { root_dir })
    }

    /// Open the default store.
    pub fn open_default() -> std::io::Result<Self> {
        Self::open(Self::default_path())
    }

    // -- install -----------------------------------------------------------

    /// Copy all files under `source_dir` into the store under `image_hash`,
    /// persist an `InstalledModel` record and an `InstallationSeal`.
    pub fn install(
        &self,
        source_dir: &Path,
        image_hash: &str,
        source_identity: &str,
        compiler_version: &str,
    ) -> std::io::Result<InstalledModel> {
        let model_dir = self.root_dir.join(image_hash);
        let segments_dir = model_dir.join("segments");
        fs::create_dir_all(&segments_dir)?;

        // Copy every regular file from source into segments/.
        let mut segment_hashes: HashMap<String, String> = HashMap::new();
        let mut file_sizes: HashMap<String, u64> = HashMap::new();

        copy_segments(source_dir, &segments_dir, &mut segment_hashes, &mut file_sizes)?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let installed_at = iso_now();

        let model = InstalledModel {
            image_hash: image_hash.to_string(),
            source_identity: source_identity.to_string(),
            installed_at,
        };

        let seal = InstallationSeal {
            image_hash: image_hash.to_string(),
            segment_hashes,
            file_sizes,
            installed_at_ms: now,
            compiler_version: compiler_version.to_string(),
        };

        // Write metadata files.
        write_json(&model_dir.join("installed.json"), &model)?;
        write_json(&model_dir.join("seal.json"), &seal)?;

        Ok(model)
    }

    // -- lookup ------------------------------------------------------------

    /// Return the `InstalledModel` for the given hash, if present.
    pub fn lookup_by_hash(&self, image_hash: &str) -> std::io::Result<Option<InstalledModel>> {
        let path = self.root_dir.join(image_hash).join("installed.json");
        if !path.exists() {
            return Ok(None);
        }
        let model: InstalledModel = read_json(&path)?;
        Ok(Some(model))
    }

    // -- list --------------------------------------------------------------

    /// List every installed model.
    pub fn list(&self) -> std::io::Result<Vec<InstalledModel>> {
        let mut models = Vec::new();
        let entries = match fs::read_dir(&self.root_dir) {
            Ok(e) => e,
            Err(_) => return Ok(Vec::new()),
        };
        for entry in entries {
            let entry = entry?;
            let meta_path = entry.path().join("installed.json");
            if meta_path.exists() {
                if let Ok(model) = read_json::<InstalledModel>(&meta_path) {
                    models.push(model);
                }
            }
        }
        Ok(models)
    }

    // -- verify_seal -------------------------------------------------------

    /// Verify the integrity seal for an installed model.
    ///
    /// Returns `Ok(())` when every file listed in the seal exists, has the
    /// correct size, and its SHA-256 digest matches the recorded value.
    /// A missing or malformed seal is treated as verification failure.
    pub fn verify_seal(&self, image_hash: &str) -> std::io::Result<()> {
        let seal_path = self.root_dir.join(image_hash).join("seal.json");
        let seal: InstallationSeal = read_json(&seal_path)?;
        let segments_dir = self.root_dir.join(image_hash).join("segments");

        for (rel_path, expected_hash) in &seal.segment_hashes {
            let full_path = segments_dir.join(rel_path);

            // Existence + size check (fast path).
            let meta = fs::metadata(&full_path)?;
            let expected_size = seal
                .file_sizes
                .get(rel_path)
                .copied()
                .unwrap_or(meta.len());
            if meta.len() != expected_size {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!(
                        "size mismatch for {}: expected {} got {}",
                        rel_path,
                        expected_size,
                        meta.len()
                    ),
                ));
            }

            // Content hash.
            let actual_hash = sha256_hex(&full_path)?;
            if &actual_hash != expected_hash {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!(
                        "hash mismatch for {}: expected {} got {}",
                        rel_path, expected_hash, actual_hash
                    ),
                ));
            }
        }

        Ok(())
    }

    // -- remove ------------------------------------------------------------

    /// Remove an installed model (directory, seal, and all segments).
    pub fn remove(&self, image_hash: &str) -> std::io::Result<()> {
        let model_dir = self.root_dir.join(image_hash);
        if model_dir.exists() {
            fs::remove_dir_all(&model_dir)?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn copy_segments(
    src: &Path,
    dst: &Path,
    hashes: &mut HashMap<String, String>,
    sizes: &mut HashMap<String, u64>,
) -> std::io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().to_string();

        if ty.is_dir() {
            // Recurse, prepend directory to the relative path.
            let sub_dst = dst.join(&name);
            fs::create_dir_all(&sub_dst)?;
            copy_segments(&entry.path(), &sub_dst, hashes, sizes)?;
            // Skip hashing the directory itself.
            continue;
        }
        if !ty.is_file() {
            continue;
        }

        let src_path = entry.path();
        let dst_path = dst.join(&name);

        let _ = fs::copy(&src_path, &dst_path)?;

        // Compute hash and size from the *source* (same bytes).
        let hash = sha256_hex(&src_path)?;
        let len = src_path.metadata()?.len();

        // Use the relative path from the top-level source.
        hashes.insert(name.clone(), hash);
        sizes.insert(name, len);
    }
    Ok(())
}

fn sha256_hex(path: &Path) -> std::io::Result<String> {
    use sha2::Digest;
    let data = fs::read(path)?;
    let hash = sha2::Sha256::digest(&data);
    Ok(format!("{:x}", hash))
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    // Simple UTC ISO-8601 without pulling in chrono.
    let days_since_epoch = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    // Days since Unix epoch (1970-01-01).
    let mut y = 1970i64;
    let mut remaining = days_since_epoch as i64;

    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }

    let month_days = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut m = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if remaining < md as i64 {
            m = i + 1;
            break;
        }
        remaining -= md as i64;
    }
    let d = remaining + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, hours, minutes, seconds
    )
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(value).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::Other, e)
    })?;
    fs::write(path, json)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> std::io::Result<T> {
    let data = fs::read_to_string(path)?;
    serde_json::from_str(&data).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e)
    })
}
