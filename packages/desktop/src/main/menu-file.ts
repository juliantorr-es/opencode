/**
 * File menu — sessions, projects, window management, GitHub PR.
 *
 * Mostly command-based items forwarded to the renderer via IPC.
 * The window.new and window.close actions are handled by the
 * menu-view-window module.
 */

import type { MenuActionRegistry } from "./menu-action-registry"
import type { BrowserWindow } from "electron"

export function registerFileMenuActions(registry: MenuActionRegistry): void {
  registry.on("github.createPullRequest", (_win: BrowserWindow | null) => {
    console.warn("github.createPullRequest is not yet implemented")
  })

  registry.add({
    id: "file",
    label: "File",
    items: [
      {
        type: "item",
        label: "New Session",
        command: "session.new",
        accelerator: { macos: "Shift+Cmd+S" },
      },
      { type: "item", label: "Open Project...", command: "project.open", accelerator: { macos: "Cmd+O" } },
      {
        type: "item",
        label: "Settings",
        command: "settings.open",
        accelerator: { windows: "Ctrl+," },
        platforms: ["windows"],
      },
      {
        type: "item",
        label: "New Window",
        action: "window.new",
        accelerator: { macos: "Cmd+Shift+N", windows: "Ctrl+Shift+N" },
      },
      { type: "separator" },
      { type: "separator" },
      { type: "item", label: "Create Pull Request...", action: "github.createPullRequest" },
      { type: "item", label: "Close Window", action: "window.close", role: "close" },
    ],
  })
}
