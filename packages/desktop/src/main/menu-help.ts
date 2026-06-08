/**
 * Help menu — external links, plugin manager, feedback channels.
 *
 * All items are either href-based (shell.openExternal) or command-based
 * (IPC push to renderer). No action handlers needed.
 */

import type { MenuActionRegistry } from "./menu-action-registry"

export function registerHelpMenuActions(registry: MenuActionRegistry): void {
  registry.add({
    id: "help",
    label: "Help",
    items: [
      { type: "item", label: "Tribunus Documentation", href: "https://tribunus.dev/docs/" },
      { type: "item", label: "Community Discussions", href: "https://tribunus.dev/discussions" },
      { type: "item", label: "Export Logs...", command: "logs.export" },
      { type: "separator" },
      {
        type: "item",
        label: "Plugin Manager",
        command: "open-plugin-manager",
        accelerator: { macos: "Cmd+Shift+P" },
      },
      { type: "separator" },
      {
        type: "item",
        label: "Share Feedback",
        href: "https://github.com/tribunus-dev/tribunus/issues/new?template=feature-request.yml",
      },
      {
        type: "item",
        label: "Report a Bug",
        href: "https://github.com/tribunus-dev/tribunus/issues/new?template=bug-report.yml",
      },
    ],
  })
}
