/**
 * Config directory migration: .opencode → .tribunus
 *
 * .tribunus/ is the canonical repo-local declarative config directory.
 * It holds project policy, workflows, agent profiles, and tool definitions.
 * It does NOT hold runtime state, secrets, caches, or databases.
 *
 * Runtime state belongs in Electron appData (or XDG-equivalent).
 * This module only handles the one-time migration of user-local config.
 *
 * Never write to .opencode — it is read-only legacy.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

const OLD_DIR = join(homedir(), ".opencode")
const NEW_DIR = join(homedir(), ".tribunus")

/**
 * One-time migration from ~/.opencode to ~/.tribunus.
 * Only READS from .opencode, only WRITES to .tribunus.
 * Never write to .opencode — it is read-only legacy.
 */
export function migrateConfigDir(): boolean {
  if (!existsSync(OLD_DIR)) return false

  console.log("[brand] Migrating .opencode → .tribunus")
  try {
    mkdirSync(NEW_DIR, { recursive: true })
    for (const entry of readdirSync(OLD_DIR)) {
      const src = join(OLD_DIR, entry)
      const dest = join(NEW_DIR, entry)
      copyFileSync(src, dest)
    }
    console.log("[brand] Migration complete: .opencode → .tribunus")
    return true
  } catch (err) {
    console.error("[brand] Migration failed:", err instanceof Error ? err.message : String(err))
    return false
  }
}

/** Returns the user-home config directory (e.g. `~/.tribunus`). */
export function configDir(): string {
  // Never write to .opencode — it is read-only legacy.
  return join(homedir(), ".tribunus")
}

/** Returns the repo-local declarative config directory (e.g. `<repo>/.tribunus`). */
export function repoConfigDir(repoRoot: string): string {
  // Never write to .opencode — it is read-only legacy.
  return join(repoRoot, ".tribunus")
}
