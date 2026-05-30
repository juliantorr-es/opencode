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
      { type: "item", label: "OpenCode Documentation", href: "https://opencode.ai/docs" },
      { type: "item", label: "Support Forum", href: "https://discord.com/invite/opencode" },
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
        href: "https://github.com/anomalyco/opencode/issues/new?template=feature_request.yml",
      },
      {
        type: "item",
        label: "Report a Bug",
        href: "https://github.com/anomalyco/opencode/issues/new?template=bug_report.yml",
      },
    ],
  })
}
