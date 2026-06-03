import { app } from "electron"
import { join } from "node:path"
import { CHANNEL, APP_IDS } from "./constants"

// ── Types ──────────────────────────────────────────────────────────────────────

export type PlatformPathKey =
  | "userData"
  | "appData"
  | "home"
  | "downloads"
  | "crashDumps"
  | "sessionData"
  | "logs"
  | "temp"
  | "exe"

export interface PlatformPaths {
  getPath(key: PlatformPathKey): string
  setPath(key: "userData" | "crashDumps" | "sessionData", path: string): void
  readonly isPackaged: boolean
  getVersion(): string
  getName(): string
  getAppId(): string
}

// ── ElectronPlatformPaths ──────────────────────────────────────────────────────

export class ElectronPlatformPaths implements PlatformPaths {
  getPath(key: PlatformPathKey): string {
    try {
      return app.getPath(key as Parameters<typeof app.getPath>[0])
    } catch {
      // Fallback for keys that may not be supported by the current Electron version
      switch (key) {
        case "logs":
          return join(app.getPath("userData"), "logs")
        default:
          return app.getPath("userData")
      }
    }
  }

  setPath(key: "userData" | "crashDumps" | "sessionData", path: string): void {
    app.setPath(key, path)
  }

  get isPackaged(): boolean {
    return app.isPackaged
  }

  getVersion(): string {
    return app.getVersion()
  }

  getName(): string {
    return app.getName()
  }

  getAppId(): string {
    return app.isPackaged ? APP_IDS[CHANNEL] : APP_IDS.dev
  }
}

export const electronPlatformPaths = new ElectronPlatformPaths()

// ── BrowserPlatformPaths ───────────────────────────────────────────────────────
// For non-Electron contexts (web browsers). Does not import from "electron".

export class BrowserPlatformPaths implements PlatformPaths {
  private store = new Map<PlatformPathKey, string>()

  private readLocalStorage(key: string): string | null {
    try {
      const ls = (globalThis as any).localStorage
      return typeof ls?.getItem === "function" ? (ls.getItem(key) as string | null) : null
    } catch {
      return null
    }
  }

  getPath(key: PlatformPathKey): string {
    // Check in-memory store first (setPath writes here)
    const stored = this.store.get(key)
    if (stored) return stored

    switch (key) {
      case "userData":
        return this.readLocalStorage("opencode:userDataPath") ?? "/opencode/data"
      case "home":
        return "/home/user"
      case "appData":
        return "/appdata"
      case "downloads":
        return "/downloads"
      case "crashDumps":
        return "/tmp/crashpad"
      case "sessionData":
        return "/tmp/session"
      case "logs":
        return "/tmp/logs"
      case "temp":
        return "/tmp"
      case "exe":
        return "/"
    }
  }

  setPath(key: "userData" | "crashDumps" | "sessionData", path: string): void {
    this.store.set(key, path)
  }

  get isPackaged(): boolean {
    return true
  }

  getVersion(): string {
    try {
      const doc = (globalThis as any).document
      if (typeof doc?.querySelector === "function") {
        const meta = doc.querySelector('meta[name="opencode-version"]')
        if (meta) {
          const version = meta.getAttribute("content")
          if (version) return version
        }
      }
    } catch {
      // ignore
    }
    return "0.0.0"
  }

  getName(): string {
    return "OpenCode"
  }

  getAppId(): string {
    return "dev.tribunus.desktop"
  }
}

export const browserPlatformPaths = new BrowserPlatformPaths()
