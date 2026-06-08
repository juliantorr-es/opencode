/**
 * Notification Gateway — Web Push API for remote cockpit alerts.
 *
 * Requires iOS 16.4+ (Home Screen installed PWA) or equivalent browser
 * with Push API + Service Worker support. Falls back to polling the
 * projection stream for gate-waiting and agent-failed events when
 * push is unavailable.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type PushAlertKind = "gate_waiting" | "agent_failed" | "gate_resolved"

export interface PushAlertPayload {
  kind: PushAlertKind
  title: string
  body: string
  /** Deep-link target for notification click. */
  actionUrl?: string
  /** Server-issued timestamp. */
  timestamp: number
}

/** Notification permission state. */
export type PushPermission = "granted" | "denied" | "unsupported" | "prompt"

export interface NotificationGatewayState {
  permission: PushPermission
  swRegistration: ServiceWorkerRegistration | null
  subscription: PushSubscription | null
}

// ── Constants ──────────────────────────────────────────────────────────

const SW_PATH = "/pwa-sw.js"
const VAPID_PUBLIC_KEY_STORAGE = "tribunus-pwa:vapid-public-key"
const SUBSCRIPTION_STORAGE = "tribunus-pwa:push-subscription"

// ── Implementation ─────────────────────────────────────────────────────

export interface NotificationGateway {
  /** Initialise the gateway: register SW and attempt push subscription. */
  init(): Promise<NotificationGatewayState>
  /** Subscribe to push notifications (call after user gesture). */
  subscribe(endpoint: string, vapidKey: string): Promise<PushSubscription>
  /** Unsubscribe from push notifications. */
  unsubscribe(): Promise<void>
  /** Current gateway state snapshot. */
  getState(): NotificationGatewayState
  /** Listen for state changes. */
  onStateChange(cb: (state: NotificationGatewayState) => void): () => void
  /** Whether push is usable in the current browser. */
  isSupported(): boolean
}

function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

function getVapidKey(): string | null {
  try {
    return localStorage.getItem(VAPID_PUBLIC_KEY_STORAGE)
  } catch {
    return null
  }
}

function setVapidKey(key: string) {
  try {
    localStorage.setItem(VAPID_PUBLIC_KEY_STORAGE, key)
  } catch {
    // noop
  }
}

function clearSubscriptionStorage() {
  try {
    localStorage.removeItem(SUBSCRIPTION_STORAGE)
  } catch {
    // noop
  }
}

function persistedSubscription(): string | null {
  try {
    return localStorage.getItem(SUBSCRIPTION_STORAGE)
  } catch {
    return null
  }
}

function persistSubscription(sub: PushSubscription) {
  try {
    localStorage.setItem(SUBSCRIPTION_STORAGE, JSON.stringify(sub.toJSON()))
  } catch {
    // noop
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.replace(/=+$/, "")
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function createNotificationGateway(): NotificationGateway {
  let state: NotificationGatewayState = {
    permission: "unsupported",
    swRegistration: null,
    subscription: null,
  }
  const stateListeners = new Set<(s: NotificationGatewayState) => void>()

  function notifyState() {
    for (const cb of stateListeners) cb(state)
  }

  function updatePermission() {
    if (!isPushSupported()) return
    if (!("Notification" in window)) {
      state = { ...state, permission: "unsupported" }
      return
    }
    const p = Notification.permission as NotificationPermission
    state = {
      ...state,
      permission: p === "granted" ? "granted" : p === "denied" ? "denied" : "prompt",
    }
  }

  async function init(): Promise<NotificationGatewayState> {
    if (!isPushSupported()) {
      state = { permission: "unsupported", swRegistration: null, subscription: null }
      return state
    }

    updatePermission()

    // Check if a stored VAPID key exists from a previous pairing
    const storedVapid = getVapidKey()
    if (storedVapid) {
      try {
        const reg = await navigator.serviceWorker.register(SW_PATH)
        await navigator.serviceWorker.ready
        state = { ...state, swRegistration: reg }

        // Attempt to restore existing subscription
        const existingSub = await reg.pushManager.getSubscription()
        if (existingSub) {
          state = { ...state, subscription: existingSub, permission: "granted" }
        }

        notifyState()
        return state
      } catch {
        // SW registration failed — degrade
        state = { ...state, swRegistration: null }
      }
    }

    notifyState()
    return state
  }

  async function subscribe(endpoint: string, vapidKey: string): Promise<PushSubscription> {
    if (!isPushSupported()) {
      throw new Error("NotificationGateway: push not supported in this browser")
    }

    // Store VAPID key for future reconnection attempts
    setVapidKey(vapidKey)

    let reg = state.swRegistration
    if (!reg) {
      reg = await navigator.serviceWorker.register(SW_PATH)
      await navigator.serviceWorker.ready
    }

    // Request notification permission
    const permission = await Notification.requestPermission()
    if (permission !== "granted") {
      state = { ...state, permission: permission === "denied" ? "denied" : "prompt" }
      notifyState()
      throw new Error("NotificationGateway: notification permission denied")
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey) as unknown as BufferSource,
    })

    state = { ...state, swRegistration: reg, subscription: sub, permission: "granted" }
    persistSubscription(sub)
    notifyState()

    return sub
  }

  async function unsubscribe(): Promise<void> {
    const sub = state.subscription
    if (sub) {
      await sub.unsubscribe()
    }
    state = { ...state, subscription: null }
    clearSubscriptionStorage()
    notifyState()
  }

  return {
    async init() { return init() },
    subscribe,
    unsubscribe,
    getState() { return state },
    onStateChange(cb) {
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },
    isSupported() { return isPushSupported() },
  }
}

export const notificationGateway = createNotificationGateway()
