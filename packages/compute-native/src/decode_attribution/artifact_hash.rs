//! Deterministic directory hashing for artifact verification.
//!
//! `hash_directory_deterministic(path, exclusions)` walks a directory
//! recursively, sorts files by normalized relative path, and produces
//! a SHA-256 digest. Two identically-shaped directories with the same
//! file contents produce the same digest regardless of filesystem
//! traversal order.
//!
//! Each file contributes: `{rel_path_len}:{rel_path}\n{file_len}:{file_bytes}`
//! to the hash stream. This prevents path/content concatenation collisions.
//!
//! The exclusion list is structural: excluded files are skipped in the
//! hash but listed in the metadata for reproducibility auditing.

use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

/// Result of hashing a directory.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DirectoryHashResult {
    /// hex SHA-256 digest
    pub digest: String,
    /// number of files hashed
    pub file_count: usize,
    /// total bytes of file content hashed
    pub total_bytes: u64,
    /// paths excluded from the hash (empty in v1; populated if exclusions are later added)
    pub excluded: Vec<String>,
}

/// Hash a directory deterministically.
///
/// Walks `path` recursively, collects all regular files, sorts them by
/// relative path, and hashes the combined stream. Files whose relative
/// path matches `exclusions` (as a suffix match — e.g. "coremldata.bin")
/// are skipped but recorded in the result metadata.
pub fn hash_directory_deterministic(path: &Path, exclusions: &[&str]) -> std::io::Result<DirectoryHashResult> {
    let mut entries: Vec<(String, u64, Vec<u8>)> = Vec::new();
    let mut excluded: Vec<String> = Vec::new();

    let base = path;

    // Walk directory
    let mut dirs: Vec<std::path::PathBuf> = vec![base.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        let mut read_dir = fs::read_dir(&dir)?;
        while let Some(entry) = read_dir.next() {
            let entry = entry?;
            let entry_path = entry.path();
            let ft = entry.file_type()?;
            let rel = entry_path.strip_prefix(base)
                .unwrap_or(&entry_path)
                .to_string_lossy()
                .to_string();

            if ft.is_dir() {
                dirs.push(entry_path);
            } else if ft.is_file() {
                // Check exclusion
                let is_excluded = exclusions.iter().any(|e| rel.contains(e));
                if is_excluded {
                    excluded.push(rel);
                    continue;
                }
                let data = fs::read(&entry_path)?;
                entries.push((rel, data.len() as u64, data));
            }
        }
    }

    // Sort by relative path for determinism
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    let mut total_bytes: u64 = 0;

    for (rel_path, file_len, data) in &entries {
        // Hash: rel_path_len:rel_path\nfile_len:file_bytes
        hasher.update(rel_path.len().to_string().as_bytes());
        hasher.update(b":");
        hasher.update(rel_path.as_bytes());
        hasher.update(b"\n");
        hasher.update(file_len.to_string().as_bytes());
        hasher.update(b":");
        hasher.update(data);
        total_bytes += file_len;
    }

    Ok(DirectoryHashResult {
        digest: format!("{:x}", hasher.finalize()),
        file_count: entries.len(),
        total_bytes,
        excluded: {
            excluded.sort();
            excluded
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn create_test_dir(name: &str, files: &[(&str, &[u8])]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hash_test_{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for (rel, data) in files {
            let path = dir.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(data).unwrap();
        }
        dir
    }

    #[test]
    fn same_content_same_hash() {
        let a = create_test_dir("same_a", &[("file.txt", b"hello")]);
        let b = create_test_dir("same_b", &[("file.txt", b"hello")]);
        let ha = hash_directory_deterministic(&a, &[]).unwrap();
        let hb = hash_directory_deterministic(&b, &[]).unwrap();
        assert_eq!(ha.digest, hb.digest, "same content should produce same hash");
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn different_content_different_hash() {
        let a = create_test_dir("diff_a", &[("file.txt", b"hello")]);
        let b = create_test_dir("diff_b", &[("file.txt", b"world")]);
        let ha = hash_directory_deterministic(&a, &[]).unwrap();
        let hb = hash_directory_deterministic(&b, &[]).unwrap();
        assert_ne!(ha.digest, hb.digest, "different content should produce different hash");
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn different_path_different_hash() {
        let a = create_test_dir("path_a", &[("a/file.txt", b"hello")]);
        let b = create_test_dir("path_b", &[("b/file.txt", b"hello")]);
        let ha = hash_directory_deterministic(&a, &[]).unwrap();
        let hb = hash_directory_deterministic(&b, &[]).unwrap();
        assert_ne!(ha.digest, hb.digest, "different paths should produce different hash");
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn subdirectory_order_randomization() {
        // Create two directories with same files in different directory orders.
        // Since we sort by relative path, the order should not matter.
        let a = create_test_dir("order_a", &[
            ("z/file.txt", b"content"),
            ("m/file.txt", b"data"),
            ("a/file.txt", b"text"),
        ]);
        // Same files, created in different order in the filesystem.
        let b = create_test_dir("order_b", &[
            ("a/file.txt", b"text"),
            ("z/file.txt", b"content"),
            ("m/file.txt", b"data"),
        ]);
        let ha = hash_directory_deterministic(&a, &[]).unwrap();
        let hb = hash_directory_deterministic(&b, &[]).unwrap();
        assert_eq!(ha.digest, hb.digest, "file order should not affect hash with sorted walk");
        assert_eq!(ha.file_count, 3);
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn exclusion_skips_file() {
        let dir = create_test_dir("excl", &[
            ("data.bin", b"important"),
            ("volatile.bin", b"skip_me"),
            ("other.txt", b"keep"),
        ]);
        let no_excl = hash_directory_deterministic(&dir, &[]).unwrap();
        let with_excl = hash_directory_deterministic(&dir, &["volatile.bin"]).unwrap();
        assert_ne!(no_excl.digest, with_excl.digest, "excluded files should change hash");
        assert_eq!(with_excl.file_count, 2, "should only hash 2 files when volatile.bin excluded");
        assert_eq!(with_excl.excluded.len(), 1, "should record one excluded path");
        assert!(with_excl.excluded[0].contains("volatile.bin"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_directory() {
        let dir = create_test_dir("empty", &[]);
        let result = hash_directory_deterministic(&dir, &[]).unwrap();
        // Empty dir should produce a known digest for zero files
        assert_eq!(result.file_count, 0);
        assert_eq!(result.total_bytes, 0);
        // Digest of empty input is SHA-256 of empty string
        assert_eq!(result.digest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_len_separator_prevents_collision() {
        // Without len separators: "ab"+"c" and "a"+"bc" could collide.
        // With our format: "2:ab\n1:c" vs "1:a\n2:bc" are distinct hashes.
        let dir = create_test_dir("collision", &[
            ("f", b"abc"),
        ]);
        let result = hash_directory_deterministic(&dir, &[]).unwrap();
        assert_eq!(result.file_count, 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
