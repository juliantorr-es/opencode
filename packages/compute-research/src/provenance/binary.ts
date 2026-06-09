/**
 * Binary provenance capture.
 *
 * Hashes built binary artifacts (napi `.node` addon, Rust worker binary)
 * and optionally Metal libraries / Core ML artifacts, returning a
 * `BinaryProvenance` record suitable for inclusion in a run manifest.
 *
 * All hashing uses SHA-256 via Bun's native CryptoHasher.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** A single binary artifact's provenance record. */
export interface BinaryArtifact {
  /** Human-readable binary name (basename). */
  name: string
  /** Normalized/relative filesystem path. */
  path: string
  /** Hex-encoded SHA-256 hash of the file content. */
  sha256: string
  /** File size in bytes. */
  byte_size: number
  /** ISO 8601 build timestamp from file modification time, if available. */
  build_timestamp?: string
}

/** Collection of binary provenance records. */
export interface BinaryProvenance {
  binaries: BinaryArtifact[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Hash a single binary file and return its provenance record.
 * Returns `null` when the file does not exist (resilient to missing binaries
 * during development or CI when only some artifacts are built).
 */
async function hashOne(name: string, absolutePath: string): Promise<BinaryArtifact | null> {
  const file = Bun.file(absolutePath)
  if (!(await file.exists())) return null

  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)

  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  const sha256 = hasher.digest("hex")

  const byteSize = bytes.byteLength

  const lastModified = file.lastModified
  const buildTimestamp =
    lastModified > 0 ? new Date(lastModified).toISOString() : undefined

  return { name, path: absolutePath, sha256, byte_size: byteSize, build_timestamp: buildTimestamp }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Capture binary provenance for the `compute-native` package.
 *
 * @param computeNativeDir – Absolute or project-relative path to the
 *   `packages/compute-native/` directory (trailing slash optional).
 * @param additional – Optional map of `{ name → filesystemPath }` for
 *   extra artifacts such as Metal libraries or Core ML compiled models.
 *
 * Always attempts to hash:
 *   1. The napi `.node` addon (e.g. `tribunus-compute-native.darwin-arm64.node`)
 *   2. The release Rust worker binary (`target/release/tribunus-compute-worker`)
 *   3. The debug Rust worker binary (`target/debug/tribunus-compute-worker`)
 *
 * Files that do not exist are silently skipped.
 */
export async function collectBinaryProvenance(
  computeNativeDir: string,
  additional?: Record<string, string>,
): Promise<BinaryProvenance> {
  const dir = computeNativeDir.replace(/\/+$/, "")

  const candidates: Array<{ name: string; path: string }> = [
    // napi addon — triple may vary by platform in future builds
    {
      name: "tribunus-compute-native.darwin-arm64.node",
      path: `${dir}/tribunus-compute-native.darwin-arm64.node`,
    },
    // Rust worker binary — release profile
    {
      name: "tribunus-compute-worker (release)",
      path: `${dir}/target/release/tribunus-compute-worker`,
    },
    // Rust worker binary — debug profile
    {
      name: "tribunus-compute-worker (debug)",
      path: `${dir}/target/debug/tribunus-compute-worker`,
    },
  ]

  const results: BinaryArtifact[] = []

  for (const { name, path } of candidates) {
    const record = await hashOne(name, path)
    if (record) results.push(record)
  }

  // Additional named artifacts (Metal libs, Core ML .mlmodelc, etc.)
  if (additional) {
    for (const [name, artifactPath] of Object.entries(additional)) {
      const record = await hashOne(name, artifactPath)
      if (record) results.push(record)
    }
  }

  return { binaries: results }
}
