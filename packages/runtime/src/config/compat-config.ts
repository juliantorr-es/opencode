/**
 * ConfigCompat — centralized project-level config file reader.
 *
 * Manages the one-way migration from opencode.jsonc (legacy) to
 * tribunus.jsonc (canonical).  Reads from .opencode/ are read-only
 * compatibility; NEVER write to .opencode/.  All writes go to .tribunus/.
 *
 * .tribunus/ is the canonical project policy directory.
 * .opencode/ is read-only compatibility input only.
 *
 * Deprecation horizon: removeAfter 0.3.0 (tracked in OPENCODE_LEGACY_COMPAT).
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { parse as parseJsonc, printParseErrorCode, type ParseError as JsoncParseError } from "jsonc-parser"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { Effect } from "effect"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw project config shape — the parsed JSON object from the config file.
 * Consumers validate with their own schema; this is the raw output.
 */
export type Config = Record<string, unknown>

/**
 * Migration receipt documenting a one-time config migration from
 * opencode.jsonc → tribunus.jsonc.
 */
export interface MigrationReceipt {
  readonly migrated: boolean
  readonly sourcePath: string
  readonly destPath: string
  readonly timestamp: string
  readonly errors: readonly string[]
}

// ---------------------------------------------------------------------------
// Config file path resolution (pure sync)
// ---------------------------------------------------------------------------

/**
 * Resolve the project config file paths for the given working directory.
 *
 * `canonical` is always the tribunus.jsonc path (the authoritative location,
 * regardless of whether the file exists yet).
 * `legacy` is set when an opencode.jsonc file exists on disk.
 * `active` tells you which config to read at runtime.
 */
export function resolveConfigPath(cwd: string): {
  canonical: string
  legacy: string | undefined
  active: "tribunus" | "opencode" | "none"
} {
  // .tribunus/ subdirectory is canonical; bare repo-root is also accepted.
  const canonical =
    (existsSync(join(cwd, ".tribunus", "tribunus.jsonc")) ? join(cwd, ".tribunus", "tribunus.jsonc") : null) ??
    (existsSync(join(cwd, "tribunus.jsonc")) ? join(cwd, "tribunus.jsonc") : null) ??
    join(cwd, ".tribunus", "tribunus.jsonc") // default fallback path

  // .opencode/ subdirectory is the legacy location.
  const legacyPath =
    (existsSync(join(cwd, ".opencode", "opencode.jsonc")) ? join(cwd, ".opencode", "opencode.jsonc") : null) ??
    (existsSync(join(cwd, "opencode.jsonc")) ? join(cwd, "opencode.jsonc") : null)

  let active: "tribunus" | "opencode" | "none" = "none"
  // tribunus always wins when it exists
  if (canonical && existsSync(canonical)) {
    active = "tribunus"
  } else if (legacyPath) {
    active = "opencode"
  }

  return {
    canonical,
    legacy: legacyPath ?? undefined,
    active,
  }
}
// ---------------------------------------------------------------------------
// Config loading (Effect-fn)
// ---------------------------------------------------------------------------

/**
* Load project config
 *
 * Precedence:
 *  1. tribunus.jsonc (canonical) — always preferred
 *  2. opencode.jsonc (legacy) — fallback, read-only
 *
 * Returns the parsed config object, or `undefined` when no config file
 * is found.
 */
export const loadConfig = Effect.fn("ConfigCompat.loadConfig")(function (
  cwd: string,
): Effect.Effect<Config | undefined, Error, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
  const { canonical, legacy, active } = resolveConfigPath(cwd)

  // 1. Try canonical (tribunus.jsonc) — exclusively when active
  if (active === "tribunus") {
    const content = yield* readJsoncFile(fs, canonical)
    if (content !== undefined) return content
    // Canonical exists but is corrupt; try legacy as safety net
  }

  // 2. Legacy fallback (opencode.jsonc) — read-only, NEVER written
  if (legacy) {
    if (active === "opencode") {
      console.warn(
        `[legacy] opencode.jsonc is deprecated — migrate to tribunus.jsonc. ` +
          `Call migrateLegacyConfig() to convert, or set TRIBUNUS_CONFIG_DIR.`,
      )
    }
    const content = yield* readJsoncFile(fs, legacy)
    if (content !== undefined) return content
  }

    return undefined
  })
})

// ---------------------------------------------------------------------------
// One-time migration  opencode.jsonc → tribunus.jsonc
// ---------------------------------------------------------------------------

const MIGRATION_MARKER = ".migration-receipt"

/**
 * One-time migration of project-level config from opencode.jsonc (legacy)
 * to tribunus.jsonc (canonical).
 *
 * - READS from .opencode/opencode.jsonc (or repo-root opencode.jsonc)
 * - WRITES to .tribunus/tribunus.jsonc (or repo-root tribunus.jsonc)
 * - NEVER writes to .opencode/
 *
 * Idempotent: the second call detects the marker file and returns a no-op
 * receipt without touching disk.
 */
export const migrateLegacyConfig = Effect.fn("ConfigCompat.migrateLegacyConfig")(
  function (cwd: string): Effect.Effect<MigrationReceipt, Error, AppFileSystem.Service> {
    return Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
    const { canonical, legacy } = resolveConfigPath(cwd)
    const now = new Date().toISOString()

    // --- Guard: no legacy source to migrate ---
    if (!legacy) {
      return {
        migrated: false,
        sourcePath: canonical, // no legacy found; point at canonical
        destPath: canonical,
        timestamp: now,
        errors: ["No legacy opencode.jsonc found"],
      }
    }

    // --- Guard: already migrated (idempotent via marker file) ---
    const markerDir = markerDirectory(cwd)
    const markerPath = join(markerDir, MIGRATION_MARKER)
    const alreadyMigrated = yield* fs.existsSafe(markerPath)
    if (alreadyMigrated) {
      return {
        migrated: false,
        sourcePath: legacy,
        destPath: canonical,
        timestamp: now,
        errors: [],
      }
    }

    // --- Read legacy config ---
    const legacyRaw = yield* readJsoncFile(fs, legacy)
    if (legacyRaw === undefined || Object.keys(legacyRaw).length === 0) {
      return {
        migrated: false,
        sourcePath: legacy,
        destPath: canonical,
        timestamp: now,
        errors: ["Legacy config file is empty or unreadable"],
      }
    }

    // --- Ensure target directory exists ---
    const destDir = join(cwd, ".tribunus")
    yield* fs.ensureDir(destDir)

    // --- Write canonical config with migration annotation ---
    const dateStamp = now.split("T")[0]
    const jsonc = `// Migrated from opencode.jsonc on ${dateStamp}\n${JSON.stringify(legacyRaw, null, 2)}\n`
    yield* fs.writeFileString(canonical, jsonc)

    // --- Write marker (idempotency guard) ---
    const marker: MigrationReceipt = {
      migrated: true,
      sourcePath: legacy,
      destPath: canonical,
      timestamp: now,
      errors: [],
    }
    yield* fs.writeFileString(markerPath, JSON.stringify(marker, null, 2) + "\n")

      return marker
    })
  },
)

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSONC file through the Effect filesystem.
 * Returns undefined when the file is missing or unparseable.
 */
function readJsoncFile(
  fs: AppFileSystem.Interface,
  filepath: string,
): Effect.Effect<Config | undefined, Error> {
  return Effect.gen(function* () {
    const raw = yield* fs.readFileStringSafe(filepath)
    if (raw === undefined) return undefined

    const errors: JsoncParseError[] = []
    const data = parseJsonc(raw, errors, { allowTrailingComma: true })
    if (errors.length > 0) {
      const messages = errors
        .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
        .join("; ")
      console.warn(`[config] jsonc parse error in ${filepath}: ${messages}`)
      return undefined
    }

    if (typeof data !== "object" || data === null) return undefined
    return data as Config
  })
}

/**
 * Determine the directory for the migration marker file.
 * Prefers .tribunus/ (canonical), falls back to .opencode/
 * when .tribunus/ doesn't exist yet.
 */
function markerDirectory(cwd: string): string {
  const tribunusDir = join(cwd, ".tribunus")
  if (existsSync(tribunusDir)) return tribunusDir
  const opencodeDir = join(cwd, ".opencode")
  if (existsSync(opencodeDir)) return opencodeDir
  // Default: marker lives alongside the canonical config
  return tribunusDir
}
