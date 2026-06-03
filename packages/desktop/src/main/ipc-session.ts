import { readFileSync, writeFileSync } from "node:fs"
import { dialog } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { registerIpcHandler } from "./ipc-registration"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"

export function registerSessionIpcHandlers() {
  registerIpcHandler(IPC.handle.SESSION_EXPORT_DATA, async (
    _event: IpcMainInvokeEvent,
    data: string,
    opts?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> },
  ) => {
    return withIpcResult("session.exportData", async () => {
      try {
        const result = await dialog.showSaveDialog({
          title: opts?.title ?? "Export Session",
          defaultPath: opts?.defaultPath,
          filters: opts?.filters,
        })
        if (result.canceled) return null
        writeFileSync(result.filePath!, data, "utf-8")
        return result.filePath
      } catch (e) {
        console.error("session-export-data failed:", e)
        return { error: (e as Error).message }
      }
    })
  })

  registerIpcHandler(IPC.handle.SESSION_IMPORT_FILE, async (
    _event: IpcMainInvokeEvent,
    opts?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> },
  ) => {
    return withIpcResult("session.importFile", async () => {
      try {
        const result = await dialog.showOpenDialog({
          title: opts?.title ?? "Import Session",
          defaultPath: opts?.defaultPath,
          properties: ["openFile"],
          filters: opts?.filters,
        })
        if (result.canceled) return null
        const content = readFileSync(result.filePaths[0], "utf-8")
        return content
      } catch (e) {
        console.error("session-import-file failed:", e)
        return { error: (e as Error).message }
      }
    })
  })
}
