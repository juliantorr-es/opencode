/**
 * MenuActionRegistry — feature modules register their menu sections
 * and action handlers instead of a monolithic DESKTOP_MENU constant.
 *
 * Usage (mirrors ipc-*.ts decomposition pattern):
 *   import { menuRegistry } from "./menu-action-registry"
 *   import { registerAppMenuActions } from "./menu-app"
 *
 *   registerAppMenuActions(menuRegistry, { checkForUpdates, relaunch })
 *   const menus = menuRegistry.build()
 *
 * The IPC handler path (ipc-window.ts) also uses menuRegistry.execute()
 * so that renderer-triggered menu actions go through the same dispatch.
 */

import type { BrowserWindow } from "electron"
import type { DesktopMenu, DesktopMenuAction } from "@tribunus/app/desktop-menu"

type ActionHandler = (win: BrowserWindow | null, ...args: unknown[]) => void

export class MenuActionRegistry {
  private sections: DesktopMenu[] = []
  private handlers = new Map<DesktopMenuAction, ActionHandler>()

  /** Register a top-level menu section. */
  add(menu: DesktopMenu): void {
    this.sections.push(menu)
  }

  /** Register a handler for a specific DesktopMenuAction. */
  on(action: DesktopMenuAction, handler: ActionHandler): void {
    this.handlers.set(action, handler)
  }

  /** Return all registered menu sections. */
  build(): DesktopMenu[] {
    return this.sections
  }

  /** Execute a registered action handler. Returns false if no handler found. */
  execute(action: DesktopMenuAction, win: BrowserWindow | null, ...args: unknown[]): boolean {
    const handler = this.handlers.get(action)
    if (handler) {
      handler(win, ...args)
      return true
    }
    return false
  }

  /** Remove all registrations (useful for testing or rebuild). */
  clear(): void {
    this.sections = []
    this.handlers.clear()
  }
}

/** Singleton used by the main process. */
export const menuRegistry = new MenuActionRegistry()
