import { BrowserWindow } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { registerIpcHandler } from "./ipc-registration"
import type { DesktopMenuAction } from "@tribunus/app/desktop-menu"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"
import type { TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { getPinchZoomEnabled, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"

export function registerWindowIpcHandlers() {
  registerIpcHandler(IPC.handle.GET_WINDOW_COUNT, () => {
    return withIpcResult("window.count", async () => BrowserWindow.getAllWindows().length)
  })

  registerIpcHandler(IPC.handle.GET_WINDOW_FOCUSED, (event: IpcMainInvokeEvent) => {
    return withIpcResult("window.getFocused", async () => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return win?.isFocused() ?? false
    })
  })

  registerIpcHandler(IPC.handle.SET_WINDOW_FOCUS, (event: IpcMainInvokeEvent) => {
    return withIpcResult("window.setFocus", async () => {
      const win = BrowserWindow.fromWebContents(event.sender)
      win?.focus()
    })
  })

  registerIpcHandler(IPC.handle.SHOW_WINDOW, (event: IpcMainInvokeEvent) => {
    return withIpcResult("window.show", async () => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })
  })

  registerIpcHandler(IPC.handle.GET_ZOOM_FACTOR, (event: IpcMainInvokeEvent) => {
    return withIpcResult("window.getZoomFactor", async () => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return 1
      return win.webContents.getZoomFactor()
    })
  })

  registerIpcHandler(IPC.handle.SET_ZOOM_FACTOR, (event: IpcMainInvokeEvent, factor: number) => {
    return withIpcResult("window.setZoomFactor", async () => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      win.webContents.zoomFactor = factor
      updateTitlebar(win)
    })
  })

  registerIpcHandler(IPC.handle.GET_PINCH_ZOOM_ENABLED, () => {
    return withIpcResult("window.getPinchZoomEnabled", async () => getPinchZoomEnabled())
  })

  registerIpcHandler(IPC.handle.SET_PINCH_ZOOM_ENABLED, (_event: IpcMainInvokeEvent, enabled: boolean) => {
    return withIpcResult("window.setPinchZoomEnabled", async () => {
      setPinchZoomEnabled(enabled)
    })
  })

  registerIpcHandler(IPC.handle.SET_TITLEBAR, (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    return withIpcResult("window.setTitlebar", async () => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      setTitlebar(win, theme)
    })
  })

  registerIpcHandler(IPC.handle.RUN_DESKTOP_MENU_ACTION, (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    return withIpcResult("window.runDesktopMenuAction", async () => {
      runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action)
    })
  })
}
