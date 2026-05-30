import { ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"

let storedLocale: string | null = null

export function registerLocaleIpcHandlers() {
  ipcMain.handle(IPC.handle.SET_LOCALE_PREFERENCE, (_event: IpcMainInvokeEvent, locale: string) => {
    return withIpcResult("locale.setPreference", async () => {
      storedLocale = locale
    })
  })
  ipcMain.handle(IPC.handle.GET_LOCALE_PREFERENCE, () => {
    return withIpcResult("locale.getPreference", async () => storedLocale)
  })
}
