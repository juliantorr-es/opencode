import { app } from "electron"
import { IPC } from "./ipc-channels"

export type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const SETTINGS_STORE = IPC.store.SETTINGS
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const PINCH_ZOOM_ENABLED_KEY = "pinchZoomEnabled"
export function getUpdaterEnabled(): boolean {
  if (process.env.TRIBUNUS_FORCE_UPDATER === "1" || process.env.TRIBUNUS_FORCE_UPDATER === "true"
    || process.env.OPENCODE_FORCE_UPDATER === "1" || process.env.OPENCODE_FORCE_UPDATER === "true") {
    return true
  }
  return app.isPackaged && CHANNEL !== "dev"
}

export const APP_IDS: Record<Channel, string> = {
  dev: "dev.tribunus.desktop.dev",
  beta: "dev.tribunus.desktop.beta",
  prod: "dev.tribunus.desktop",
}
