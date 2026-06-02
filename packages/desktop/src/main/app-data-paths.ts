import { join } from "path"
import { mkdirSync } from "fs"

export interface AppDataPaths {
  userData: string
  state: string
  config: string
  cache: string
  data: string
  logs: string
  db: string
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
    OPENCODE_DESKTOP_USER_DATA: paths.userData,
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
