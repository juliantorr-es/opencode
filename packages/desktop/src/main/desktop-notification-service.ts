import { Notification, BrowserWindow } from "electron"
import { registerIpcHandler } from "./ipc-registration"
import { IPC } from "./ipc-channels"
import { withIpcResult } from "./ipc-contract"
import { getStore } from "./store"

export type DesktopNotificationKind =
  | "agent_blocked"
  | "review_required"
  | "release_binder_complete"
  | "project_activation_failed"
  | "sidecar_failed"

export interface DesktopNotificationInput {
  kind: DesktopNotificationKind
  title: string
  body: string
  actionRef?: string
  project?: string
}

export interface NotificationPreferences {
  enabled: boolean
  agentBlocked: boolean
  reviewRequired: boolean
  releaseBinderComplete: boolean
  projectActivationFailed: boolean
  sidecarFailed: boolean
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: true,
  agentBlocked: true,
  reviewRequired: true,
  releaseBinderComplete: true,
  projectActivationFailed: true,
  sidecarFailed: true,
}

const STORE_KEY = "notifications.preferences"

function getPreferences(): NotificationPreferences {
  const store = getStore()
  const raw = store.get(STORE_KEY)
  if (!raw) return { ...DEFAULT_PREFERENCES }
  return { ...DEFAULT_PREFERENCES, ...(raw as Partial<NotificationPreferences>) }
}

function setPreferences(prefs: NotificationPreferences): void {
  const store = getStore()
  store.set(STORE_KEY, prefs)
}

// Track suppressors: the OS-level state is unknown until first notification.
// We expose it via status().
let lastPermission: "granted" | "denied" | "unknown" = "unknown"

function isSupported(): boolean {
  return Notification.isSupported()
}

export function getNotificationStatus() {
  return {
    supported: isSupported(),
    enabled: getPreferences().enabled,
    permission: lastPermission,
  }
}

export function setNotificationPreferences(prefs: Partial<NotificationPreferences>): void {
  const current = getPreferences()
  const next = { ...current, ...prefs }
  setPreferences(next)
}

export function notify(input: DesktopNotificationInput): boolean {
  if (!isSupported()) return false

  const prefs = getPreferences()
  if (!prefs.enabled) return false

  // Check per-kind toggle
  switch (input.kind) {
    case "agent_blocked": if (!prefs.agentBlocked) return false; break
    case "review_required": if (!prefs.reviewRequired) return false; break
    case "release_binder_complete": if (!prefs.releaseBinderComplete) return false; break
    case "project_activation_failed": if (!prefs.projectActivationFailed) return false; break
    case "sidecar_failed": if (!prefs.sidecarFailed) return false; break
  }

  const notification = new Notification({
    title: input.title,
    body: input.body,
    silent: false,
  })

  notification.on("click", () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.focus()
      if (input.actionRef) {
        win.webContents.send("tribunus:push:notification-action", {
          actionRef: input.actionRef,
          kind: input.kind,
          project: input.project,
        })
      }
    }
  })

  notification.show()
  lastPermission = "granted"
  return true
}

export function registerNotificationIpcHandlers() {
  registerIpcHandler(IPC.handle.NOTIFICATIONS_NOTIFY, async (_event, opts: DesktopNotificationInput) =>
    withIpcResult("notifications.notify", () => Promise.resolve(notify(opts)))
  )
  registerIpcHandler(IPC.handle.NOTIFICATIONS_STATUS, async () =>
    withIpcResult("notifications.status", () => Promise.resolve(getNotificationStatus()))
  )
  registerIpcHandler(IPC.handle.NOTIFICATIONS_SET_PREFERENCES, async (_event, prefs: Partial<NotificationPreferences>) =>
    withIpcResult("notifications.setPreferences", () => Promise.resolve(setNotificationPreferences(prefs)))
  )
}
