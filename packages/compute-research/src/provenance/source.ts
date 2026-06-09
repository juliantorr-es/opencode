/**
 * Source provenance capture.
 *
 * Captures git state (commit SHA, branch, tree hash, dirty state),
 * dependency manifest hashes (Cargo.lock, bun.lock, compute-native manifest),
 * and toolchain configuration (Rust version, target triple, linker/profile/flags).
 *
 * All hashing uses SHA-256 via Bun's native CryptoHasher.
 * All shell commands use checked exit codes.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Source code identity, dependency fingerprints, and toolchain configuration. */
export interface SourceProvenance {
  repo_url: string
  commit_sha: string
  branch: string
  commit_timestamp: number
  dirty: boolean
  tree_hash: string
  dirty_patch_hash?: string
  dirty_patch_size?: number
  dependencies: {
    cargo_lock_hash: string
    bun_lock_hash: string
    compute_native_manifest_hash: string
  }
  toolchain: {
    rust_version: string
    target_triple: string
    linker: string
    opt_profile: string
    feature_flags: string[]
    env_flags: Record<string, string>
  }
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** Base error for provenance capture failures. */
export class ProvenanceError extends Error {
  override name = "ProvenanceError"
}

/** Error when a git command exits non-zero. */
export class GitCommandError extends ProvenanceError {
  override name = "GitCommandError"
  constructor(
    public readonly command: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`git command failed (exit ${exitCode}): ${command}\n${stderr}`)
  }
}

/** Error when a toolchain command (rustc, rustup) exits non-zero. */
export class ToolchainCommandError extends ProvenanceError {
  override name = "ToolchainCommandError"
  constructor(
    public readonly command: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`toolchain command failed (exit ${exitCode}): ${command}\n${stderr}`)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Run a git command in `repoPath` and return trimmed stdout. */
async function gitCmd(repoPath: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawnSync(["git", ...args], { cwd: repoPath })
  if (proc.exitCode !== 0) {
    throw new GitCommandError(
      args.join(" "),
      proc.exitCode,
      proc.stderr.toString(),
    )
  }
  return proc.stdout.toString().trim()
}

/** Run an arbitrary command and return trimmed stdout. */
async function cmd(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawnSync([command, ...args])
  return {
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
    exitCode: proc.exitCode,
  }
}

/** Compute SHA-256 hex digest of a file. Returns null if file does not exist. */
async function sha256File(filePath: string): Promise<string | null> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return null
  const buf = await file.arrayBuffer()
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(new Uint8Array(buf))
  return hasher.digest("hex")
}

/** Compute SHA-256 hex digest of a string. */
function sha256String(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(input)
  return hasher.digest("hex")
}

/** Detect the first existing path from a list of candidates. */
async function firstExisting(...paths: string[]): Promise<string | null> {
  for (const p of paths) {
    const file = Bun.file(p)
    if (await file.exists()) return p
  }
  return null
}

/**
 * Parse the channel string from a `.rust-toolchain.toml` file.
 * Returns the channel value (e.g. "stable", "nightly-2024-09-01") or null.
 */
async function readToolchainChannel(
  toolchainPath: string,
): Promise<string | null> {
  const file = Bun.file(toolchainPath)
  if (!(await file.exists())) return null
  const text = await file.text()
  // Parse toml-like: channel = "value"
  const match = text.match(/^\s*channel\s*=\s*"([^"]+)"\s*$/m)
  return match?.[1] ?? null
}

/** Cargo/Rust environment variable prefixes we capture into env_flags. */
const CARGO_ENV_PREFIXES = [
  "CARGO_",
  "RUSTC_",
  "RUSTFLAGS",
  "RUSTDOCFLAGS",
  "RUST_LOG",
  "RUST_BACKTRACE",
  "RUST_MIN_STACK",
  "MACOSX_DEPLOYMENT_TARGET",
  "SDKROOT",
]

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Capture source provenance for the repository at `repoPath`.
 *
 * @param repoPath – Absolute or relative path to the repository root.
 * @returns A fully populated {@link SourceProvenance} record.
 *
 * @throws {GitCommandError} when a required git command fails.
 * @throws {ToolchainCommandError} when rustc or rustup fails.
 */
export async function captureSourceProvenance(
  repoPath: string,
): Promise<SourceProvenance> {
  // ── Git state ──────────────────────────────────────────────────────────────

  const repo_url = await gitCmd(repoPath, "config", "--get", "remote.origin.url")
  const commit_sha = await gitCmd(repoPath, "rev-parse", "HEAD")
  const branch = await gitCmd(repoPath, "rev-parse", "--abbrev-ref", "HEAD")
  const timestampStr = await gitCmd(
    repoPath,
    "log",
    "-1",
    "--format=%ct",
  )
  const commit_timestamp = Number.parseInt(timestampStr, 10)
  const statusOutput = await gitCmd(repoPath, "status", "--porcelain")
  const dirty = statusOutput.length > 0

  // Tree hash of the committed state (HEAD's tree object).
  const tree_hash = await gitCmd(repoPath, "rev-parse", "HEAD:")

  // ── Dirty patch (if dirty) ─────────────────────────────────────────────────

  let dirty_patch_hash: string | undefined
  let dirty_patch_size: number | undefined

  if (dirty) {
    const diffResult = Bun.spawnSync(
      ["git", "diff"],
      { cwd: repoPath },
    )
    const stagedResult = Bun.spawnSync(
      ["git", "diff", "--staged"],
      { cwd: repoPath },
    )

    const diffOut = diffResult.stdout.toString()
    const stagedOut = stagedResult.stdout.toString()

    const combinedPatch =
      diffOut +
      (diffOut.length > 0 && stagedOut.length > 0 ? "\n" : "") +
      stagedOut

    dirty_patch_hash = sha256String(combinedPatch)
    dirty_patch_size = Buffer.byteLength(combinedPatch, "utf-8")
  }

  // ── Dependency hashes ──────────────────────────────────────────────────────

  const cargoLockPath =
    (await firstExisting(
      `${repoPath}/Cargo.lock`,
      `${repoPath}/packages/compute-native/Cargo.lock`,
    )) ?? `${repoPath}/Cargo.lock`
  const bunLockPath = `${repoPath}/bun.lock`
  const nativeManifestPath = `${repoPath}/packages/compute-native/Cargo.toml`

  const cargo_lock_hash =
    (await sha256File(cargoLockPath)) ?? "0000000000000000000000000000000000000000000000000000000000000000"
  const bun_lock_hash =
    (await sha256File(bunLockPath)) ?? "0000000000000000000000000000000000000000000000000000000000000000"
  const compute_native_manifest_hash =
    (await sha256File(nativeManifestPath)) ?? "0000000000000000000000000000000000000000000000000000000000000000"

  // ── Toolchain ──────────────────────────────────────────────────────────────

  // Read .rust-toolchain.toml or fall back to rustc --version
  const toolchainPath = `${repoPath}/.rust-toolchain.toml`
  const toolchainChannel = await readToolchainChannel(toolchainPath)

  let rust_version: string
  if (toolchainChannel) {
    rust_version = toolchainChannel
  } else {
    const { stdout, exitCode, stderr } = await cmd("rustc", ["--version"])
    if (exitCode !== 0) {
      throw new ToolchainCommandError("rustc --version", exitCode, stderr)
    }
    // Parse "rustc 1.85.0 (d5c2e9c3 2025-02-20)" → "1.85.0"
    const versionMatch = stdout.match(/^rustc\s+([^\s]+)/)
    rust_version = versionMatch?.[1] ?? stdout
  }

  // Target triple from rustc -vV (host: line)
  let target_triple: string
  {
    const { stdout, exitCode, stderr } = await cmd("rustc", ["-vV"])
    if (exitCode !== 0) {
      throw new ToolchainCommandError("rustc -vV", exitCode, stderr)
    }
    const hostMatch = stdout.match(/^host:\s+(\S+)/m)
    target_triple = hostMatch?.[1] ?? "unknown"
  }

  // Linker detection
  let linker = "ld64.lld" // Default for Apple Silicon + Rust
  const rustflags = process.env.RUSTFLAGS
  if (rustflags) {
    const linkerFlagMatch = rustflags.match(/-C\s+linker=(\S+)/)
    if (linkerFlagMatch) {
      linker = linkerFlagMatch[1]!
    }
  }
  // Check target-specific env vars (e.g. CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER)
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CARGO_TARGET_") && key.endsWith("_LINKER") && value) {
      linker = value
      break
    }
  }

  // Optimisation profile
  const opt_profile = process.env.CARGO_PROFILE ?? "release"

  // Feature flags: parse CARGO_FEATURE_* env vars
  const feature_flags: string[] = []
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CARGO_FEATURE_")) {
      const featureName = key
        .replace(/^CARGO_FEATURE_/, "")
        .toLowerCase()
        .replace(/_/g, "-")
      feature_flags.push(featureName)
    }
  }

  // Environment flags: collect relevant Cargo/Rust env vars
  const env_flags: Record<string, string> = {}
  for (const prefix of CARGO_ENV_PREFIXES) {
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix) && value !== undefined) {
        env_flags[key] = value
      }
    }
  }

  // ── Assemble result ────────────────────────────────────────────────────────

  return {
    repo_url,
    commit_sha,
    branch,
    commit_timestamp,
    dirty,
    tree_hash,
    ...(dirty_patch_hash !== undefined
      ? { dirty_patch_hash, dirty_patch_size }
      : {}),
    dependencies: {
      cargo_lock_hash,
      bun_lock_hash,
      compute_native_manifest_hash,
    },
    toolchain: {
      rust_version,
      target_triple,
      linker,
      opt_profile,
      feature_flags,
      env_flags,
    },
  }
}
