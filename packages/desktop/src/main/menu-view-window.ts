/**
 * Edit, View, and Window menus — all webContents-level operations
 * (undo/redo/clipboard, devtools, zoom, fullscreen) and window operations
 * (new, close, minimize, maximize).
 *
 * These are grouped because all action handlers are simple method calls
 * on the focused BrowserWindow or its webContents, sharing the same
 * pattern: action → win?.method() call.
 */

import type { MenuActionRegistry } from "./menu-action-registry"
import type { BrowserWindow } from "electron"
import { createMainWindow } from "./windows"

export function registerEditViewWindowMenuActions(registry: MenuActionRegistry): void {
  // ── Edit menu ──────────────────────────────────────────────
  registry.add({
    id: "edit",
    label: "Edit",
    items: [
      { type: "item", label: "Undo", action: "edit.undo", role: "undo", accelerator: { windows: "Ctrl+Z" } },
      { type: "item", label: "Redo", action: "edit.redo", role: "redo", accelerator: { windows: "Ctrl+Y" } },
      { type: "separator" },
      { type: "item", label: "Cut", action: "edit.cut", role: "cut", accelerator: { windows: "Ctrl+X" } },
      { type: "item", label: "Copy", action: "edit.copy", role: "copy", accelerator: { windows: "Ctrl+C" } },
      { type: "item", label: "Paste", action: "edit.paste", role: "paste", accelerator: { windows: "Ctrl+V" } },
      { type: "item", label: "Delete", action: "edit.delete" },
      {
        type: "item",
        label: "Select All",
        action: "edit.selectAll",
        role: "selectAll",
        accelerator: { windows: "Ctrl+A" },
      },
    ],
  })

  // ── View menu ──────────────────────────────────────────────
  registry.add({
    id: "view",
    label: "View",
    items: [
      { type: "item", label: "Toggle Sidebar", command: "sidebar.toggle", accelerator: { macos: "Cmd+B" } },
      { type: "item", label: "Toggle Terminal", command: "terminal.toggle", accelerator: { macos: "Ctrl+`" } },
      { type: "item", label: "Toggle File Tree", command: "fileTree.toggle" },
      { type: "separator" },
      { type: "item", label: "Reload", action: "view.reload", role: "reload" },
      { type: "item", label: "Toggle Developer Tools", action: "view.toggleDevTools", role: "toggleDevTools" },
      { type: "separator" },
      {
        type: "item",
        label: "Actual Size",
        action: "view.resetZoom",
        role: "resetZoom",
        accelerator: { windows: "Ctrl+0" },
      },
      { type: "item", label: "Zoom In", action: "view.zoomIn", role: "zoomIn", accelerator: { windows: "Ctrl++" } },
      { type: "item", label: "Zoom Out", action: "view.zoomOut", role: "zoomOut", accelerator: { windows: "Ctrl+-" } },
      { type: "separator" },
      { type: "item", label: "Toggle Full Screen", action: "view.toggleFullscreen", role: "togglefullscreen" },
    ],
  })

  // ── Go menu ──────────────────────────────────────────────
  registry.add({
    id: "go",
    label: "Go",
    items: [
      { type: "item", label: "Back", command: "common.goBack", accelerator: { macos: "Cmd+[" } },
      { type: "item", label: "Forward", command: "common.goForward", accelerator: { macos: "Cmd+]" } },
      { type: "separator" },
      { type: "item", label: "Previous Session", command: "session.previous", accelerator: { macos: "Option+Up" } },
      { type: "item", label: "Next Session", command: "session.next", accelerator: { macos: "Option+Down" } },
      { type: "separator" },
      {
        type: "item",
        label: "Previous Project",
        command: "project.previous",
        accelerator: { macos: "Cmd+Option+Up" },
      },
      {
        type: "item",
        label: "Next Project",
        command: "project.next",
        accelerator: { macos: "Cmd+Option+Down" },
      },
    ],
  })

  // ── Window menu ──────────────────────────────────────────
  registry.add({
    id: "window",
    label: "Window",
    role: "windowMenu",
    items: [
      { type: "item", label: "Minimize", action: "window.minimize" },
      { type: "item", label: "Maximize", action: "window.toggleMaximize" },
      { type: "separator" },
      { type: "item", label: "Close Window", action: "window.close" },
    ],
  })

  // ── Action handlers ─────────────────────────────────────

  // Edit actions — delegate to webContents
  registry.on("edit.undo", (win) => win?.webContents.undo())
  registry.on("edit.redo", (win) => win?.webContents.redo())
  registry.on("edit.cut", (win) => win?.webContents.cut())
  registry.on("edit.copy", (win) => win?.webContents.copy())
  registry.on("edit.paste", (win) => win?.webContents.paste())
  registry.on("edit.delete", (win) => win?.webContents.delete())
  registry.on("edit.selectAll", (win) => win?.webContents.selectAll())

  // View actions — reload, devtools, zoom
  registry.on("view.reload", (win) => win?.reload())
  registry.on("view.toggleDevTools", (win) => win?.webContents.toggleDevTools())
  registry.on("view.resetZoom", (win) => {
    setZoom(win, 1)
  })
  registry.on("view.zoomIn", (win) => {
    setZoom(win, (win?.webContents.getZoomFactor() ?? 1) + 0.2)
  })
  registry.on("view.zoomOut", (win) => {
    setZoom(win, (win?.webContents.getZoomFactor() ?? 1) - 0.2)
  })
  registry.on("view.toggleFullscreen", (win) => {
    if (!win) return
    win.setFullScreen(!win.isFullScreen())
  })

  // Window actions
  registry.on("window.new", () => createMainWindow())
  registry.on("window.minimize", (win) => win?.minimize())
  registry.on("window.toggleMaximize", (win) => {
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
      return
    }
    win.maximize()
  })
  registry.on("window.close", (win) => win?.close())
}

function setZoom(win: Electron.BrowserWindow | null, value: number) {
  if (!win) return
  win.webContents.setZoomFactor(Math.min(Math.max(value, 0.2), 10))
}
