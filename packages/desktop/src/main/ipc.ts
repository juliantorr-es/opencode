import { app, BrowserWindow, ipcMain } from "electron"
import type { StorageMigrationProgress } from "../preload/types"
import { IPC } from "./ipc-channels"
import { registerConfigIpcHandlers } from "./ipc-config"
import { registerStoreIpcHandlers } from "./ipc-store"
import { registerFsIpcHandlers } from "./ipc-fs"
import { registerSessionIpcHandlers } from "./ipc-session"
import { registerWindowIpcHandlers } from "./ipc-window"
import { registerLocaleIpcHandlers } from "./ipc-locale"
import { registerInitIpcHandlers } from "./ipc-init"
import type { Deps as InitDeps } from "./ipc-init"
import { registerGithubIpcHandlers } from "./github-ipc"
import { registerPluginTransportIpcHandlers } from "./plugin-transport-ipc"
import { registerCapabilitiesIpcHandlers } from "./ipc-capabilities"
import { registerGitIpcHandlers } from "./ipc-git"
import { registerSecretIpcHandlers } from "./desktop-secret-store"
import { registerNotificationIpcHandlers } from "./desktop-notification-service"
import { validateRegisteredIpcHandlers } from "./ipc-registration"
let registered = false

export function registerIpcHandlers(deps: InitDeps) {
  if (registered) return
  registered = true

  registerInitIpcHandlers(deps)
  registerConfigIpcHandlers()
  registerStoreIpcHandlers()
  registerFsIpcHandlers()
  registerSessionIpcHandlers()
  registerWindowIpcHandlers()
  registerLocaleIpcHandlers()
  registerGithubIpcHandlers()
  registerPluginTransportIpcHandlers()
  registerCapabilitiesIpcHandlers()
  registerGitIpcHandlers()
  registerSecretIpcHandlers()
  registerNotificationIpcHandlers()

  const issues = validateRegisteredIpcHandlers()
  if (issues.length > 0) {
    console.error("[IPC Registry] Mismatch between IPC_METHOD_REGISTRY and registered handlers:")
    for (const issue of issues) console.error(`  • ${issue}`)
  }

  // Direct relaunch — renderer sends this to trigger app restart
  ipcMain.on(IPC.send.RELAUNCH, (event) => {
    if (!event.sender) {
      console.error("[ipc] RELAUNCH: blocked — no sender")
      return
    }
    app.relaunch()
    app.exit(0)
  })
}

export function sendStorageMigrationProgress(win: BrowserWindow, progress: StorageMigrationProgress) {
  win.webContents.send(IPC.push.STORAGE_MIGRATION_PROGRESS, progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send(IPC.push.MENU_COMMAND, id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send(IPC.push.DEEP_LINK, urls)
}
