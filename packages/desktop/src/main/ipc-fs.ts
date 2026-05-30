import { execFile } from "node:child_process"
import { clipboard, dialog, ipcMain, Notification, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"

const pickerFilters = (ext?: string[]) => {
  if (!ext?.length) return undefined
  return [{ name: "Files", extensions: ext }]
}

export function registerFsIpcHandlers() {
  ipcMain.handle(
    IPC.handle.OPEN_DIRECTORY_PICKER,
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      return withIpcResult("fs.openDirectoryPicker", async () => {
        const result = await dialog.showOpenDialog({
          properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
          title: opts?.title ?? "Choose a folder",
          defaultPath: opts?.defaultPath,
        })
        if (result.canceled) return null
        return opts?.multiple ? result.filePaths : result.filePaths[0]
      })
    },
  )

  ipcMain.handle(
    IPC.handle.OPEN_FILE_PICKER,
    async (
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
    },
  )

  ipcMain.handle(
    IPC.handle.SAVE_FILE_PICKER,
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      return withIpcResult("fs.saveFilePicker", async () => {
        const result = await dialog.showSaveDialog({
          title: opts?.title ?? "Save file",
          defaultPath: opts?.defaultPath,
        })
        if (result.canceled) return null
        return result.filePath ?? null
      })
    },
  )

  ipcMain.on(IPC.send.OPEN_LINK, (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  ipcMain.handle(IPC.handle.OPEN_PATH, async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    return withIpcResult("fs.openPath", async () => {
      if (!app) return shell.openPath(path)
      await new Promise<void>((resolve, reject) => {
        const [cmd, args] =
          process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
        execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
      })
    })
  })

  ipcMain.handle(IPC.handle.READ_CLIPBOARD_IMAGE, () => {
    return withIpcResult("fs.readClipboardImage", async () => {
      const image = clipboard.readImage()
      if (image.isEmpty()) return null
      const buffer = image.toPNG().buffer
      const size = image.getSize()
      return { buffer, width: size.width, height: size.height }
    })
  })

  ipcMain.on(IPC.send.SHOW_NOTIFICATION, (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })
}
