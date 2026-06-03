import { registerIpcHandler } from "./ipc-registration"
import type { IpcMainInvokeEvent } from "electron"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"

let storedLocale: string | null = null

export function registerLocaleIpcHandlers() {
  registerIpcHandler(IPC.handle.SET_LOCALE_PREFERENCE, (_event: IpcMainInvokeEvent, locale: string) => {
    return withIpcResult("locale.setPreference", async () => {
      storedLocale = locale
    })
  })
  registerIpcHandler(IPC.handle.GET_LOCALE_PREFERENCE, () => {
    return withIpcResult("locale.getPreference", async () => storedLocale)
  })
}
