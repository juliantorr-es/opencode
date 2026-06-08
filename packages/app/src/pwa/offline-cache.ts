/**
 * Offline Cache — IndexedDB-backed projection cache for offline resilience.
 *
 * Listens to the projection stream, persists every delta into IndexedDB,
 * and surfaces cached projections when offline. Discards cached data on
 * successful reconnect. Exposes banner visibility and a pending
 * notification queue for offline UX.
 *
 * Usage:
 *   import { offlineCache } from "@/pwa/offline-cache"
 *   offlineCache.init(projectionStream)
 *   offlineCache.onBannerChange((visible) => setShowBanner(visible))
 */

import type { ProjectionStreamClient, ProjectionDelta, ConnectionStatus } from "./projection-stream"

// ── Types ──────────────────────────────────────────────────────────────

/** A notification that was generated while offline and queued for display. */
export interface OfflineNotification {
  id: string
  kind: string
  title: string
  body: string
  timestamp: number
  /** Whether the user has dismissed this notification. */
  dismissed: boolean
}

export type BannerVisibility = "hidden" | "offline" | "reconnecting"

// ── Constants ──────────────────────────────────────────────────────────

const DB_NAME = "tribunus-pwa-offline-cache"
const DB_VERSION = 1
const PROJECTIONS_STORE = "projections"
const NOTIFICATIONS_STORE = "notifications"
const MAX_PROJECTIONS = 500
const MAX_NOTIFICATIONS = 50

// ── Implementation ─────────────────────────────────────────────────────

export interface OfflineCache {
  /** Initialise — subscribes to the given projection stream. */
  init(stream: ProjectionStreamClient): void
  /** Tear down subscriptions and close DB. */
  destroy(): void
  /** Read all cached projections from IndexedDB (newest first). */
  getCachedProjections(): Promise<ProjectionDelta[]>
  /** Number of cached projections. */
  cachedCount(): Promise<number>
  /** Current banner visibility. */
  readonly banner: BannerVisibility
  /** Listen for banner visibility changes. Returns unsubscribe fn. */
  onBannerChange(cb: (banner: BannerVisibility) => void): () => void
  /** Dismiss the banner manually. */
  dismissBanner(): void
  /** Get undismissed offline notifications. */
  getOfflineNotifications(): OfflineNotification[]
  /** Mark a notification as dismissed. */
  dismissNotification(id: string): void
  /** Clear all persisted data (projections + notifications). */
  clearAll(): Promise<void>
}

function openDB(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>()
  const req = indexedDB.open(DB_NAME, DB_VERSION)

  req.onupgradeneeded = () => {
    const db = req.result
    if (!db.objectStoreNames.contains(PROJECTIONS_STORE)) {
      const store = db.createObjectStore(PROJECTIONS_STORE, { keyPath: "id" })
      store.createIndex("timestamp", "timestamp", { unique: false })
    }
    if (!db.objectStoreNames.contains(NOTIFICATIONS_STORE)) {
      const store = db.createObjectStore(NOTIFICATIONS_STORE, { keyPath: "id" })
      store.createIndex("timestamp", "timestamp", { unique: false })
    }
  }

  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
  return promise
}

export function createOfflineCache(): OfflineCache {
  let dbPromise: Promise<IDBDatabase> | null = null
  let banner: BannerVisibility = "hidden"
  let unsubDelta: (() => void) | null = null
  let unsubStatus: (() => void) | null = null

  const bannerListeners = new Set<(b: BannerVisibility) => void>()
  const pendingNotifications: OfflineNotification[] = []

  // ── DB helpers ────────────────────────────────────────────────────────

  async function ensureDB(): Promise<IDBDatabase> {
    if (!dbPromise) dbPromise = openDB()
    return dbPromise
  }

  async function storeProjection(delta: ProjectionDelta) {
    try {
      const db = await ensureDB()
      const tx = db.transaction(PROJECTIONS_STORE, "readwrite")
      const store = tx.objectStore(PROJECTIONS_STORE)

      // Prune if over limit
      const countReq = store.count()
      countReq.onsuccess = () => {
        const count = countReq.result
        if (count >= MAX_PROJECTIONS) {
          const index = store.index("timestamp")
          const cursorReq = index.openCursor(null, "next")
          let toDelete = count - MAX_PROJECTIONS + 1
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (cursor && toDelete > 0) {
              store.delete(cursor.primaryKey)
              toDelete--
              cursor.continue()
            }
          }
        }
      }

      store.put({ id: `${delta.kind}:${delta.cursor}`, ...delta })
    } catch {
      // DB unavailable — degrade gracefully
    }
  }

  async function discardCache() {
    try {
      const db = await ensureDB()
      const tx = db.transaction(PROJECTIONS_STORE, "readwrite")
      const store = tx.objectStore(PROJECTIONS_STORE)
      store.clear()
    } catch {
      // noop
    }
  }

  // ── Banner ────────────────────────────────────────────────────────────

  function setBanner(b: BannerVisibility) {
    if (banner === b) return
    banner = b
    for (const cb of bannerListeners) cb(b)
  }

  // ── Notifications ─────────────────────────────────────────────────────

  function queueNotification(delta: ProjectionDelta) {
    const { kind, payload, timestamp } = delta
    let title = "Update"
    let body = ""

    if (kind === "gate_event") {
      title = "Gate Event"
      body = (payload?.message as string) ?? "A gate requires attention"
    } else if (kind === "gate_waiting") {
      title = "Gate Waiting"
      body = (payload?.gateName as string) ?? "A gate is waiting for approval"
    } else if (kind === "agent_status") {
      title = "Agent Status"
      body = (payload?.agentName as string)
        ? `${payload.agentName} — ${payload?.status ?? "updated"}`
        : (payload?.message as string) ?? "Agent status changed"
    } else if (kind === "mission_progress") {
      title = "Mission Progress"
      body = (payload?.message as string) ?? "Mission updated"
    } else {
      return // Only notify for meaningful events
    }

    pendingNotifications.push({
      id: `offline:${timestamp}:${kind}`,
      kind,
      title,
      body,
      timestamp,
      dismissed: false,
    })

    // Cap the pending list
    while (pendingNotifications.length > MAX_NOTIFICATIONS) pendingNotifications.shift()
  }

  // ── Stream subscriptions ──────────────────────────────────────────────

  function onDelta(delta: ProjectionDelta) {
    storeProjection(delta)
    if (banner === "offline") {
      queueNotification(delta)
    }
  }

  function onStatusChange(status: ConnectionStatus) {
    if (status === "connected") {
      // Successful reconnect — discard cached projections
      discardCache()
      setBanner("hidden")
    } else if (status === "reconnecting") {
      setBanner("reconnecting")
    } else if (status === "disconnected") {
      setBanner("offline")
    }
    // "connecting" leaves banner as-is
  }

  // ── Public API ────────────────────────────────────────────────────────

  const cache: OfflineCache = {
    get banner() { return banner },

    init(stream) {
      cache.destroy()
      unsubDelta = stream.onDelta(onDelta)
      unsubStatus = stream.onStatusChange(onStatusChange)
      // Seed banner from current stream state
      if (stream.status === "disconnected") setBanner("offline")
      else if (stream.status === "reconnecting") setBanner("reconnecting")
    },

    destroy() {
      if (unsubDelta) { unsubDelta(); unsubDelta = null }
      if (unsubStatus) { unsubStatus(); unsubStatus = null }
      dbPromise = null
      setBanner("hidden")
    },

    async getCachedProjections() {
      try {
        const db = await ensureDB()
        const { promise, resolve, reject } = Promise.withResolvers<ProjectionDelta[]>()
        const tx = db.transaction(PROJECTIONS_STORE, "readonly")
        const store = tx.objectStore(PROJECTIONS_STORE)
        const index = store.index("timestamp")
        const req = index.openCursor(null, "prev") // newest first

        const results: ProjectionDelta[] = []
        req.onsuccess = () => {
          const cursor = req.result
          if (cursor) {
            const { id: _id, ...rest } = cursor.value as ProjectionDelta & { id: string }
            results.push(rest)
            cursor.continue()
          } else {
            resolve(results)
          }
        }
        req.onerror = () => reject(req.error)
        return promise
      } catch {
        return []
      }
    },

    async cachedCount() {
      try {
        const db = await ensureDB()
        const tx = db.transaction(PROJECTIONS_STORE, "readonly")
        const store = tx.objectStore(PROJECTIONS_STORE)
        const { promise, resolve, reject } = Promise.withResolvers<number>()
        const req = store.count()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        return promise
      } catch {
        return 0
      }
    },

    dismissBanner() {
      setBanner("hidden")
    },

    onBannerChange(cb) {
      bannerListeners.add(cb)
      return () => bannerListeners.delete(cb)
    },

    getOfflineNotifications() {
      return pendingNotifications.filter((n) => !n.dismissed)
    },

    dismissNotification(id: string) {
      const n = pendingNotifications.find((n) => n.id === id)
      if (n) n.dismissed = true
    },

    async clearAll() {
      pendingNotifications.length = 0
      try {
        const db = await ensureDB()
        const tx = db.transaction([PROJECTIONS_STORE, NOTIFICATIONS_STORE], "readwrite")
        tx.objectStore(PROJECTIONS_STORE).clear()
        tx.objectStore(NOTIFICATIONS_STORE).clear()
      } catch {
        // noop
      }
      setBanner("hidden")
    },
  }

  return cache
}

export const offlineCache = createOfflineCache()
