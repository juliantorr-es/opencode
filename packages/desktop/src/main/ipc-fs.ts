import { execFile } from "node:child_process"
import { clipboard, dialog, ipcMain, Notification, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { registerIpcHandler } from "./ipc-registration"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"

const pickerFilters = (ext?: string[]) => {
  if (!ext?.length) return undefined
  return [{ name: "Files", extensions: ext }]
}

export function registerFsIpcHandlers() {
  registerIpcHandler(IPC.handle.OPEN_DIRECTORY_PICKER, async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
    return withIpcResult("fs.openDirectoryPicker", async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    })
  })

  registerIpcHandler(IPC.handle.OPEN_FILE_PICKER, async (
    _event: IpcMainInvokeEvent,
    opts?: { multiple?: boolean; title?: string; defaultPath?: string; accept?: string[]; extensions?: string[] },
  ) => {
    return withIpcResult("fs.openFilePicker", async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    })
  })

  registerIpcHandler(IPC.handle.SAVE_FILE_PICKER, async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
    return withIpcResult("fs.saveFilePicker", async () => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    })
  })

  ipcMain.on(IPC.send.OPEN_LINK, (_event: IpcMainEvent, url: string) => {
    const allowed = url.startsWith("https://") || url.startsWith("http://")
    if (!allowed) {
      console.warn("[ipc] OPEN_LINK: blocked non-http(s) URL", url)
      return
    }
    void shell.openExternal(url)
  })

  registerIpcHandler(IPC.handle.OPEN_PATH, async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    return withIpcResult("fs.openPath", async () => {
      if (!app) return shell.openPath(path)
      await new Promise<void>((resolve, reject) => {
        const [cmd, args] =
          process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
        execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
      })
    })
  })

  registerIpcHandler(IPC.handle.READ_CLIPBOARD_IMAGE, () => {
    return withIpcResult("fs.readClipboardImage", async () => {
      const image = clipboard.readImage()
      if (image.isEmpty()) return null
      const buffer = image.toPNG().buffer
      const size = image.getSize()
      return { buffer, width: size.width, height: size.height }
    })
  })

  ipcMain.on(IPC.send.SHOW_NOTIFICATION, (event: IpcMainEvent, title: string, body?: string) => {
    if (!event.sender) return
    new Notification({ title, body }).show()
  })
}
