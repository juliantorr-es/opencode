/** Release qualification evidence manifest. One manifest per candidate artifact. */
export interface ReleaseQualificationManifest {
  /** Unique manifest identifier (UUID v4) */
  manifestId: string
  /** ISO 8601 timestamp when the manifest was generated */
  generatedAt: string

  /** Source identity */
  source: {
    /** Full git commit SHA */
    commit: string
    /** Short commit SHA */
    commitShort: string
    /** Whether the working tree was clean */
    treeClean: boolean
    /** Uncommitted diff hash if dirty */
    patchHash?: string
    /** Repository URL or identifier */
    repository: string
  }

  /** Artifact identity */
  artifact: {
    /** File name (e.g., "Tribunus-1.0.0-arm64.dmg") */
    name: string
    /** SHA-256 hex digest */
    sha256: string
    /** File size in bytes */
    sizeBytes: number
    /** Release channel */
    channel: "dev" | "beta" | "prod"
    /** Semantic version */
    version: string
    /** Operating system */
    platform: "darwin" | "win32" | "linux"
    /** CPU architecture */
    arch: "arm64" | "x64"
    /** Package format */
    format: "dmg" | "zip" | "nsis" | "appimage" | "deb" | "rpm"
    /** Electron version bundled */
    electronVersion: string
    /** Bun version used for build */
    bunVersion: string
  }

  /** Native resource inventory */
  nativeResources: Array<{
    /** Relative path within the package */
    path: string
    /** SHA-256 hex digest */
    sha256: string
    /** Architecture */
    arch: string
    /** File type (macho, pe, elf, dylib, node-addon) */
    type: string
    /** Whether the binary is signed */
    signed: boolean
    /** Code signing identity if signed */
    signIdentity?: string
    /** Whether ABI loading succeeded in the test environment */
    loadOk: boolean
  }>

  /** Signing and notarization */
  signing: {
    /** Whether the outer application bundle is signed */
    appSigned: boolean
    /** Signing identity */
    identity?: string
    /** Whether hardened runtime is enabled (macOS) */
    hardenedRuntime?: boolean
    /** Whether notarization passed (macOS) */
    notarized?: boolean
    /** Whether the installer is signed (Windows) */
    installerSigned?: boolean
    /** Whether update signature verification is enabled */
    updateSignatureEnabled: boolean
  }

  /** Test qualification matrix */
  tests: {
    /** Total test count */
    total: number
    /** Passing test count */
    pass: number
    /** Failing test count */
    fail: number
    /** Skipped test count */
    skip: number
    /** Test suite revision (commit SHA of test files) */
    suiteRevision: string
    /** Per-gate status */
    gates: Record<string, GateResult>
  }

  /** Gate results for each qualification gate */
  gates: Record<string, GateResult>

  /** Known risks accepted for this release */
  acceptedRisks: Array<{
    /** Risk identifier */
    id: string
    /** Human-readable description */
    description: string
    /** Affected platforms */
    platforms: string[]
    /** Compensating controls */
    controls: string
    /** Risk owner */
    owner: string
    /** ISO 8601 expiration date */
    expiresAt: string
  }>

  /** Release decision */
  decision: ReleaseDecision
}

/** Result of a single qualification gate */
export interface GateResult {
  /** Gate name (e.g., "typecheck", "sender-policy", "packaged-launch") */
  gate: string
  /** Whether the gate passed */
  passed: boolean
  /** ISO 8601 timestamp */
  timestamp: string
  /** Duration in milliseconds */
  durationMs: number
  /** Human-readable summary */
  summary: string
  /** Artifact references (log paths, screenshot paths, receipt paths) */
  artifacts: string[]
}

/** Release decision vocabulary */
export type ReleaseDecision =
  | { status: "qualified" }
  | { status: "qualified-with-accepted-risk"; risks: string[] }
  | { status: "rejected"; reason: string }
  | { status: "incomplete"; missing: string[] }

/** Supported platform entry */
export interface PlatformSupport {
  platform: "darwin" | "win32" | "linux"
  arch: "arm64" | "x64"
  /** Support level */
  level: "fully-supported" | "beta-supported" | "best-effort" | "build-only" | "not-offered"
  /** Package formats produced */
  formats: string[]
}

/** Supported platform matrix for the release */
export const SUPPORTED_PLATFORM_MATRIX: PlatformSupport[] = [
  { platform: "darwin", arch: "arm64", level: "fully-supported", formats: ["dmg", "zip"] },
  { platform: "darwin", arch: "x64", level: "beta-supported", formats: ["dmg", "zip"] },
  { platform: "win32", arch: "x64", level: "fully-supported", formats: ["nsis"] },
  { platform: "linux", arch: "x64", level: "beta-supported", formats: ["appimage", "deb", "rpm"] },
]
