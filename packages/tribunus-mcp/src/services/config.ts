/**
 * Service Store Config — resolves PGlite and code-intelligence store roots
 * consistently with the MCP-managed store skeleton.
 */

import { resolve, join } from "node:path"
import { homedir } from "node:os"

function managedStoreRoot(): string {
  if (process.env.TRIBUNUS_STORE_DIR) return process.env.TRIBUNUS_STORE_DIR
  return resolve(process.cwd(), "packages", "tribunus-mcp", "state")
}

export function getPgliteDir(): string {
  return join(managedStoreRoot(), "pglite")
}

export function getCodeIntelligenceDir(): string {
  return join(managedStoreRoot(), "code-intelligence")
}

export function getCodeIntelligenceDbDir(): string {
  return join(getCodeIntelligenceDir(), "pglite")
}

export function getCodeIntelligenceMigrationDir(): string {
  return resolve(new URL("..", import.meta.url).pathname, "services", "code-intelligence", "store", "migrations")
}
