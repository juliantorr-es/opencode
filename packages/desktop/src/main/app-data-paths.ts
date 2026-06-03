import { app } from "electron"
import { join } from "path"
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, writeFileSync } from "fs"

export interface AppDataPaths {
  userData: string
  state: string
  config: string
  cache: string
  data: string
  logs: string
  db: string
}

export interface DesktopRuntimePaths {
  userData: string
  stateHome: string
  configHome: string
  cacheHome: string
  logHome: string
  pgliteDir: string
  valkeyDir: string
}

export function getDesktopRuntimePaths(): DesktopRuntimePaths {
  const userData = app.getPath("userData")
  return {
    userData,
    stateHome: join(userData, "state"),
    configHome: join(userData, "config"),
    cacheHome: join(userData, "cache"),
    logHome: join(userData, "logs"),
    pgliteDir: join(userData, "state", "pglite"),
    valkeyDir: join(userData, "state", "valkey"),
  }
}

export function resolveDesktopAppDataPaths(userDataPath: string): AppDataPaths {
  return {
    userData: userDataPath,
    state: join(userDataPath, "state"),
    config: join(userDataPath, "config"),
    cache: join(userDataPath, "cache"),
    data: join(userDataPath, "data"),
    logs: join(userDataPath, "logs"),
    db: join(userDataPath, "state", "pglite"),
  }
}

export function ensureDesktopAppDataPaths(paths: AppDataPaths) {
  for (const p of [paths.state, paths.config, paths.cache, paths.data, paths.logs, paths.db]) {
    mkdirSync(p, { recursive: true })
  }
}

export const ensureDirectories = ensureDesktopAppDataPaths

export function getDbPath(paths: AppDataPaths): string {
  return paths.db
}

export function getLogPath(paths: AppDataPaths): string {
  return paths.logs
}

export function report(paths: AppDataPaths) {
  return {
    userDataPath: paths.userData,
    statePath: paths.state,
    dbPath: paths.db,
    configPath: paths.config,
    cachePath: paths.cache,
    logPath: paths.logs,
  }
}

export function envForDesktopAppData(paths: AppDataPaths): Record<string, string> {
  return {
    TRIBUNUS_USER_DATA: paths.userData,
    TRIBUNUS_STATE_HOME: paths.state,
    TRIBUNUS_CONFIG_HOME: paths.config,
    TRIBUNUS_CACHE_HOME: paths.cache,
    TRIBUNUS_DATA_HOME: paths.data,
    TRIBUNUS_LOG_HOME: paths.logs,
    OPENCODE_USER_DATA: paths.userData,
    OPENCODE_STATE_HOME: paths.state,
    OPENCODE_CONFIG_HOME: paths.config,
    OPENCODE_CACHE_HOME: paths.cache,
    OPENCODE_DATA_HOME: paths.data,
    OPENCODE_LOG_HOME: paths.logs,
    XDG_STATE_HOME: paths.state,
    XDG_CONFIG_HOME: paths.config,
    XDG_CACHE_HOME: paths.cache,
    XDG_DATA_HOME: paths.data,
  }
}

/**
 * Migrate app data from old opencode identity to new Tribunus identity.
 * Called once at app startup, before any data is written to the new path.
 *
 * Old: ~/Library/Application Support/ai.opencode.desktop.dev
 * New: ~/Library/Application Support/dev.tribunus.desktop
 */
export function migrateAppDataIfNeeded(oldUserDataPath: string, newUserDataPath: string): boolean {
  // Already migrated
  if (existsSync(newUserDataPath)) return false

  // No old data to migrate
  if (!existsSync(oldUserDataPath)) return false

  console.log("[brand] Migrating app data from", oldUserDataPath, "to", newUserDataPath)

  try {
    mkdirSync(newUserDataPath, { recursive: true })

    // Copy safe state selectively
    const safeDirs = ["state", "data"]
    const safeFiles = ["config.json", "settings.json"]

    for (const entry of readdirSync(oldUserDataPath)) {
      const src = join(oldUserDataPath, entry)
      const dst = join(newUserDataPath, entry)

      if (entry.startsWith(".")) continue
      if (entry === "Cache" || entry === "Code Cache" || entry === "GPUCache") continue
      if (entry === "Crashpad" || entry === "blob_storage") continue
      if (entry.endsWith(".log")) continue

      const stat = statSync(src)
      if (stat.isDirectory() && safeDirs.includes(entry)) {
        copyRecursive(src, dst)
      } else if (stat.isFile() && safeFiles.includes(entry)) {
        copyFileSync(src, dst)
      }
    }

    // Record migration
    writeFileSync(
      join(newUserDataPath, ".migration-receipt.json"),
      JSON.stringify({
        migratedAt: Date.now(),
        oldPath: oldUserDataPath,
        newPath: newUserDataPath,
        product: "Tribunus",
      }, null, 2),
      "utf-8"
    )

    console.log("[brand] App data migration complete")
    return true
  } catch (err) {
    console.error("[brand] App data migration failed:", err instanceof Error ? err.message : String(err))
    return false
  }
}

function copyRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry)
    const dstPath = join(dst, entry)
    const stat = statSync(srcPath)
    if (stat.isDirectory()) {
      copyRecursive(srcPath, dstPath)
    } else {
      copyFileSync(srcPath, dstPath)
    }
  }
}
