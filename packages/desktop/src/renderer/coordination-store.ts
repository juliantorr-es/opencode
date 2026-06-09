import { createSignal } from "solid-js"

export interface CoordinationSnapshot {
  readonly revision: number
  readonly backendMode: string
  readonly available: boolean
  readonly schedulerState: string
  readonly consumerHealth: string
  readonly readyCount: number | "unavailable"
  readonly scheduledCount: number | "unavailable"
  readonly activeAttempts: number | "unavailable"
  readonly retryScheduled: number | "unavailable"
  readonly deadLetterCount: number | "unavailable"
  readonly quarantineCount: number | "unavailable"
  readonly rebuildNeeded: boolean | "unavailable"
  readonly calculatedAt: string
}

export interface CoordinationDelta {
  readonly streamId: string
  readonly sequence: number
  readonly previousRevision: number
  readonly resultingRevision: number
  readonly changed: readonly string[]
  readonly snapshot: CoordinationSnapshot
  readonly emittedAt: string
}

export type CoordinationStatus = "unavailable" | "connecting" | "synchronized" | "stale" | "degraded" | "failed" | "resynchronizing"

export interface CoordinationStore {
  readonly snapshot: () => CoordinationSnapshot | null
  readonly status: () => CoordinationStatus
  readonly lastUpdate: () => string | null
  readonly applySnapshot: (snap: CoordinationSnapshot) => void
  readonly applyDelta: (delta: CoordinationDelta) => void
  readonly markUnavailable: () => void
  readonly markDegraded: () => void
  readonly requestResync: () => void
}

export function createCoordinationStore(): CoordinationStore {
  const [snapshot, setSnapshot] = createSignal<CoordinationSnapshot | null>(null)
  const [status, setStatus] = createSignal<CoordinationStatus>("unavailable")
  const [lastUpdate, setLastUpdate] = createSignal<string | null>(null)
  let streamId: string | null = null
  let expectedSequence = 0

  /** Apply initial snapshot */
  function applySnapshot(snap: CoordinationSnapshot) {
    setSnapshot(snap)
    setStatus("synchronized")
    setLastUpdate(snap.calculatedAt)
    expectedSequence = 1
  }

  /** Apply a delta — validates sequence and revision */
  function applyDelta(delta: CoordinationDelta) {
    if (streamId !== null && delta.streamId !== streamId) {
      // Different stream — request resync
      setStatus("resynchronizing")
      requestResync()
      return
    }
    if (streamId === null) streamId = delta.streamId

    if (delta.sequence !== expectedSequence) {
      // Gap detected — stop and request resync
      setStatus("stale")
      requestResync()
      return
    }
    if (delta.previousRevision !== snapshot()?.revision) {
      setStatus("stale")
      requestResync()
      return
    }
    setSnapshot(delta.snapshot)
    setStatus("synchronized")
    setLastUpdate(delta.emittedAt)
    expectedSequence = delta.sequence + 1
  }

  function requestResync() {
    setStatus("resynchronizing")
    if (typeof window !== "undefined" && window.api?.requestCoordinationResync) {
      window.api.requestCoordinationResync()
    }
  }

  function markUnavailable() { setStatus("unavailable") }
  function markDegraded() { setStatus("degraded") }

  return { snapshot, status, lastUpdate, applySnapshot, applyDelta, markUnavailable, markDegraded, requestResync }
}
