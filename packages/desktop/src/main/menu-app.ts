/**
 * Application menu — macOS-only "OpenCode" menu.
 *
 * Registers menu structure and action handlers for:
 *   app.checkForUpdates  — triggers updater check
 *   app.relaunch         — restarts the app
 *
 * Commands (settings.open, logs.export) are forwarded to the
 * renderer via deps.trigger().
 */

import type { MenuActionRegistry } from "./menu-action-registry"


export type AppMenuDeps = {
  checkForUpdates: () => void
  relaunch: () => void
}

export function registerAppMenuActions(registry: MenuActionRegistry, deps: AppMenuDeps): void {
  registry.add({
    id: "app",
    label: "OpenCode",
    platforms: ["macos"],
    items: [
      { type: "item", role: "about" },
      { type: "item", label: "Check for Updates...", action: "app.checkForUpdates", enabled: "updater" },
      { type: "item", label: "Settings", command: "settings.open", accelerator: { macos: "Cmd+," } },
      { type: "item", label: "Reload Webview", action: "view.reload" },
      { type: "item", label: "Restart", action: "app.relaunch" },
      { type: "item", label: "Export Logs...", command: "logs.export" },
      { type: "separator" },
      { type: "item", role: "hide" },
      { type: "item", role: "hideOthers" },
      { type: "item", role: "unhide" },
      { type: "separator" },
      { type: "item", role: "quit" },
    ],
  })

  registry.on("app.checkForUpdates", () => {
    deps.checkForUpdates()
  })

  registry.on("app.relaunch", () => {
    deps.relaunch()
  })
}
