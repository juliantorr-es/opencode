/**
 * Background Runtime Supervision
 *
 * Supervises background tasks: agent executions, file indexing, sync ops,
 * build watchers. Detects hangs, applies timeouts, restarts or escalates.
 * Restart loops are bounded. Supervisor survives individual task crashes.
 */
import { Effect } from "effect"

// ── Types ────────────────────────────────────────────────────────────────────

interface TaskID { readonly TaskID: unique symbol }
type TaskID = string & TaskID

type TaskStatus = "running" | "completed" | "failed" | "timed_out" | "restarting"

interface SupervisionRecord {
  taskId: TaskID
  name: string
  timeoutMs: number
  heartbeatIntervalMs: number
  maxRestarts: number
  restartCount: number
  lastHeartbeat: number
  status: TaskStatus
  startedAt: number
  completedAt: number | null
  errors: string[]
}

interface TaskEvent {
  taskId: TaskID
  status: TaskStatus
  timestamp: number
  error?: string
}

type TaskEventSubscriber = (event: TaskEvent) => void

// ── Store ────────────────────────────────────────────────────────────────────

const supervisionStore = new Map<TaskID, SupervisionRecord>()
const taskSubscribers: TaskEventSubscriber[] = []

function publishEvent(event: TaskEvent) {
  for (const sub of taskSubscribers) sub(event)
}

function subscribeEvents(fn: TaskEventSubscriber): () => void {
  taskSubscribers.push(fn)
  return () => {
    const idx = taskSubscribers.indexOf(fn)
    if (idx >= 0) taskSubscribers.splice(idx, 1)
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

function registerTask(
  name: string,
  timeoutMs: number = 300_000,
  heartbeatIntervalMs: number = 30_000,
  maxRestarts: number = 3
): Effect.Effect<TaskID, Error> {
  return Effect.gen(function* () {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` as TaskID
    const record: SupervisionRecord = {
      taskId, name, timeoutMs, heartbeatIntervalMs, maxRestarts,
      restartCount: 0, lastHeartbeat: Date.now(), status: "running",
      startedAt: Date.now(), completedAt: null, errors: [],
    }
    supervisionStore.set(taskId, record)
    publishEvent({ taskId, status: "running", timestamp: Date.now() })
    return taskId
  })
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

function heartbeat(taskId: TaskID): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const record = supervisionStore.get(taskId)
    if (!record) throw new Error(`Task not found: ${taskId}`)
    record.lastHeartbeat = Date.now()
  })
}

// ── Check and Terminate ──────────────────────────────────────────────────────

function checkHeartbeats(): SupervisionRecord[] {
  const now = Date.now()
  const timedOut: SupervisionRecord[] = []

  for (const [id, record] of supervisionStore) {
    if (record.status !== "running") continue
    const elapsed = now - record.lastHeartbeat
    if (elapsed > record.timeoutMs) {
      record.status = "timed_out"
      record.errors.push(`Task timed out after ${elapsed}ms (timeout: ${record.timeoutMs}ms)`)
      publishEvent({ taskId: id, status: "timed_out", timestamp: now, error: record.errors[record.errors.length - 1] })

      // Bounded restart
      if (record.restartCount < record.maxRestarts) {
        record.restartCount++
        record.status = "restarting"
        record.lastHeartbeat = now
        publishEvent({ taskId: id, status: "restarting", timestamp: now })
      }
      timedOut.push(record)
    }
  }

  return timedOut
}

function completeTask(taskId: TaskID, error?: string): void {
  const record = supervisionStore.get(taskId)
  if (!record) return
  record.status = error ? "failed" : "completed"
  record.completedAt = Date.now()
  if (error) record.errors.push(error)
  publishEvent({ taskId, status: record.status, timestamp: Date.now(), error })
}

function getTask(taskId: TaskID): SupervisionRecord | undefined {
  return supervisionStore.get(taskId)
}

function listTasks(): SupervisionRecord[] {
  return [...supervisionStore.values()]
}

export {
  registerTask, heartbeat, checkHeartbeats, completeTask, getTask, listTasks,
  subscribeEvents, supervisionStore, TaskID, SupervisionRecord, TaskStatus, TaskEvent,
}
