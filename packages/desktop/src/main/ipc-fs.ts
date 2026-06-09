import { execFile } from "node:child_process"
import { clipboard, dialog, ipcMain, Notification, shell } from "electron"
import type { IpcMainEvent } from "electron"
import { Effect } from "effect"
import { IPC } from "./ipc-channels"
import { registerIpcEffectHandler } from "./ipc-adapter"
import type { DesktopRuntime } from "./effect/desktop-runtime"
import * as S from "../ipc/schema-compat"

const pickerFilters = (ext?: string[]) => {
  if (!ext?.length) return undefined
  return [{ name: "Files", extensions: ext }]
}

export function registerFsIpcHandlers(runtime: DesktopRuntime) {
  // ── OPEN_DIRECTORY_PICKER ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.OPEN_DIRECTORY_PICKER,
    params: S.Tuple([S.Optional(S.Struct({
      multiple: S.Optional(S.Bool),
      title: S.Optional(S.Str),
      defaultPath: S.Optional(S.Str),
    }))]),
    success: S.Nullable(S.Str),
    timeout: 0, // no timeout — waits for user
    senderPolicy: "standard",
    mapError: () => null,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [opts] = params as [any]
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
      title: opts?.title ?? "Choose a folder",
      defaultPath: opts?.defaultPath,
    })
    if (result.canceled) return null
    return opts?.multiple ? result.filePaths : result.filePaths[0]
  }))

  // ── OPEN_FILE_PICKER ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.OPEN_FILE_PICKER,
    params: S.Tuple([S.Optional(S.Struct({
      multiple: S.Optional(S.Bool),
      title: S.Optional(S.Str),
      defaultPath: S.Optional(S.Str),
      accept: S.Optional(S.Arr(S.Str)),
      extensions: S.Optional(S.Arr(S.Str)),
    }))]),
    success: S.Nullable(S.Str),
    timeout: 0,
    senderPolicy: "standard",
    mapError: () => null,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [opts] = params as [any]
    const result = await dialog.showOpenDialog({
      properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
      title: opts?.title ?? "Choose a file",
      defaultPath: opts?.defaultPath,
      filters: pickerFilters(opts?.extensions),
    })
    if (result.canceled) return null
    return opts?.multiple ? result.filePaths : result.filePaths[0]
  }))

  // ── SAVE_FILE_PICKER ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.SAVE_FILE_PICKER,
    params: S.Tuple([S.Optional(S.Struct({
      title: S.Optional(S.Str),
      defaultPath: S.Optional(S.Str),
    }))]),
    success: S.Nullable(S.Str),
    timeout: 0,
    senderPolicy: "standard",
    mapError: () => null,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [opts] = params as [any]
    const result = await dialog.showSaveDialog({
      title: opts?.title ?? "Save file",
      defaultPath: opts?.defaultPath,
    })
    if (result.canceled) return null
    return result.filePath ?? null
  }))

  // ── OPEN_LINK (hardened send → stays send with validation) ──
  ipcMain.on(IPC.send.OPEN_LINK, (_event: IpcMainEvent, url: unknown) => {
    if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
      console.warn("[ipc] OPEN_LINK: rejected invalid URL length/type")
      return
    }
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      console.warn("[ipc] OPEN_LINK: blocked non-http(s) URL", url)
      return
    }
    void shell.openExternal(url)
  })

  // ── OPEN_PATH ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.OPEN_PATH,
    params: S.Tuple([S.Str, S.Optional(S.Str)]),
    success: S.UndefinedConst,
    timeout: 30_000,
    senderPolicy: "strict",
    mapError: () => null,
  }, (params: unknown) => Effect.tryPromise(async () => {
    const [path, app] = params as [string, string | undefined]
    if (!app) {
      const result = await shell.openPath(path)
      if (result) throw new Error(`openPath failed: ${result}`)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] = process.platform === "darwin"
        ? (["open", ["-a", app, path]] as const)
        : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  }))

  // ── READ_CLIPBOARD_IMAGE ──
  registerIpcEffectHandler(runtime, {
    channel: IPC.handle.READ_CLIPBOARD_IMAGE,
    params: S.Tuple([]),
    success: S.Nullable(S.Struct({
      buffer: S.Unknown,
      width: S.Num,
      height: S.Num,
    })),
    timeout: 5_000,
    senderPolicy: "standard",
    mapError: () => null,
  }, () => Effect.tryPromise(async () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  }))

  // ── SHOW_NOTIFICATION (hardened send with validation) ──
  ipcMain.on(IPC.send.SHOW_NOTIFICATION, (event: IpcMainEvent, title: unknown, body?: unknown) => {
    if (!event.sender || event.sender.isDestroyed()) return
    if (typeof title !== "string" || title.length === 0 || title.length > 256) {
      console.warn("[ipc] SHOW_NOTIFICATION: rejected invalid title")
      return
    }
    if (body !== undefined && (typeof body !== "string" || body.length > 1024)) {
      console.warn("[ipc] SHOW_NOTIFICATION: rejected invalid body")
      return
    }
    if (!Notification.isSupported()) {
      console.warn("[ipc] SHOW_NOTIFICATION: notifications not supported")
      return
    }
    new Notification({ title, body: body as string | undefined }).show()
  })
}
