/**
 * Config directory migration: .opencode → .tribunus
 *
 * .tribunus/ is the canonical repo-local declarative config directory.
 * It holds project policy, workflows, agent profiles, and tool definitions.
 * It does NOT hold runtime state, secrets, caches, or databases.
 *
 * Runtime state belongs in Electron appData (or XDG-equivalent).
 * This module only handles the one-time migration of user-local config.
 */

import { homedir } from "os"
import { join } from "path"

/** Returns the user-home config directory (e.g. `~/.tribunus`). */
export function configDir(): string {
  return join(homedir(), ".tribunus")
}

/** Returns the repo-local declarative config directory (e.g. `<repo>/.tribunus`). */
export function repoConfigDir(repoRoot: string): string {
  return join(repoRoot, ".tribunus")
}
