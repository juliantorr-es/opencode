import { Effect } from "effect"

/** Renderer-safe coordination snapshot — no internal Valkey types exposed */
export interface CoordinationSnapshot {
  readonly revision: number
  readonly backendMode: "local" | "local-valkey" | "remote-valkey" | "unavailable"
  readonly available: boolean
  readonly schedulerState: "running" | "paused" | "stopped" | "unavailable"
  readonly consumerHealth: "healthy" | "degraded" | "unavailable"
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

type DeltaListener = (delta: CoordinationDelta) => void

function buildSnapshot(revision: number): CoordinationSnapshot {
  return {
    revision,
    backendMode: "unavailable",
    available: false,
    schedulerState: "unavailable",
    consumerHealth: "unavailable",
    readyCount: "unavailable",
    scheduledCount: "unavailable",
    activeAttempts: "unavailable",
    retryScheduled: "unavailable",
    deadLetterCount: "unavailable",
    quarantineCount: "unavailable",
    rebuildNeeded: "unavailable",
    calculatedAt: new Date().toISOString(),
  }
}

/** The projection service — scoped under DesktopRuntime. Read-only. */
export function makeCoordinationProjectionService() {
  let revision = 0
  let sequence = 0
  const streamId = `coordination-projection-${Date.now()}`
  const listeners = new Set<DeltaListener>()

  function emitChange(changed: string[], update: Partial<CoordinationSnapshot>) {
    revision++
    sequence++
    const snapshot: CoordinationSnapshot = { ...buildSnapshot(revision), ...update, revision }
    const delta: CoordinationDelta = {
      streamId,
      sequence,
      previousRevision: revision - 1,
      resultingRevision: revision,
      changed,
      snapshot,
      emittedAt: new Date().toISOString(),
    }
    for (const listener of listeners) {
      try { listener(delta) } catch { /* discard listener errors */ }
    }
  }

  return {
    getSnapshot(): CoordinationSnapshot {
      return buildSnapshot(revision)
    },

    /** Subscribe to deltas. Returns unsubscribe function. */
    subscribeDeltas(listener: DeltaListener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    setSidecarReady(ready: boolean) {
      emitChange(["available", "backendMode", "schedulerState", "consumerHealth"], {
        available: ready,
        backendMode: ready ? "local" : "unavailable",
        schedulerState: ready ? "running" : "stopped",
        consumerHealth: ready ? "healthy" : "unavailable",
      })
    },

    setDegraded() {
      emitChange(["schedulerState", "consumerHealth"], {
        schedulerState: "paused",
        consumerHealth: "degraded",
      })
    },

    dispose() {
      listeners.clear()
    },
  }
}
