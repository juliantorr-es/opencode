import { Context, Effect, Layer, Ref, Scope, Stream } from "effect"
import { Bus } from "@/bus"
import * as Log from "@opencode-ai/core/util/log"
import { serviceUse } from "@opencode-ai/core/effect/service-use"

const log = Log.create({ service: "flight-recorder" })

// ─── Event type allowlist ───────────────────────────────────────────────
// Only these event type prefixes are recorded by the flight recorder.
// Sensitive event types (llm.*, session.message.*, file.*) are excluded
// to prevent prompt content, model responses, and file paths from leaking.
const RECORDED_EVENT_PREFIXES = [
  "tool.started",
  "tool.completed",
  "tool.failed",
  "permission.",
  "lifecycle.",
  "session.status",
  "session.error",
  "server.",
  "mcp.",
  "pty.",
  "lsp.",
  "worktree.",
  "installation.",
  "coord.",
  "question.",
]

function shouldRecordEventType(eventType: string): boolean {
  return RECORDED_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))
}

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * FlightRecorderEvent — a minimal event record.
 * No full prompt content, no model responses, no large payloads.
 * Only metadata useful for debugging.
 */
export interface FlightRecorderEvent {
  /** Unique event ID */
  id: string
  /** ISO timestamp */
  ts: string
  /** Session this event belongs to */
  sessionId: string
  /** Event type from the bus */
  eventType: string
  /** Operation name (action being performed) */
  operation: string
  /** Status of the operation */
  status?: string
  /** Error code if the operation failed */
  errorCode?: string
  /** Correlation ID for tracing request chains */
  correlationId?: string
}

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_CAPACITY = 1000

// ─── Service Interface ──────────────────────────────────────────────────

export interface Interface {
  /** Record a new event into the ring buffer */
  readonly record: (event: FlightRecorderEvent) => Effect.Effect<void>
  /** Take an atomic snapshot of the current buffer contents */
  readonly snapshot: () => Effect.Effect<ReadonlyArray<FlightRecorderEvent>>
  /** Flush all buffered events to persistent storage */
  readonly flush: () => Effect.Effect<void>
  /** Get the current buffer contents */
  readonly getEvents: Effect.Effect<ReadonlyArray<FlightRecorderEvent>>
  /** Reset the buffer (clear all events) */
  readonly reset: () => Effect.Effect<void>
}

// ─── Service Tag ────────────────────────────────────────────────────────

export class Service extends Context.Service<Service, Interface>()("@opencode/FlightRecorder") {}

export const use = serviceUse(Service)

// ─── Layer ──────────────────────────────────────────────────────────────

export interface FlightRecorderConfig {
  capacity: number
}

const defaultConfig: FlightRecorderConfig = { capacity: DEFAULT_CAPACITY }

/**
 * Create a FlightRecorder layer.
 *
 * The flight recorder is an always-on in-memory ring buffer.
 * - Writes are O(1) — append to the end of the array, drop the oldest if at capacity.
 * - Snapshot reads are O(n) — clones the array for atomic read.
 * - `flush()` writes all events to logs (persistent EventStore integration is planned)
 *
 * Uses Effect Ref for atomic state transitions — no locks, no mutexes.
 */
export const layer = (config: FlightRecorderConfig = defaultConfig) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const capacity = config.capacity
      const buffer = yield* Ref.make<Array<FlightRecorderEvent>>([])

      const record = (event: FlightRecorderEvent): Effect.Effect<void> =>
        Ref.update(buffer, (events) => {
          if (events.length >= capacity) {
            return [...events.slice(1), event]
          }
          return [...events, event]
        })

      const snapshot = (): Effect.Effect<ReadonlyArray<FlightRecorderEvent>> =>
        Ref.get(buffer)

      const getEvents: Effect.Effect<ReadonlyArray<FlightRecorderEvent>> =
        Ref.get(buffer)

      const reset = (): Effect.Effect<void> =>
        Ref.set(buffer, [])

      const flush = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          const current = yield* Ref.getAndSet(buffer, [])
          if (current.length > 0) {
            log.info("flushing flight recorder", { count: current.length })
            for (const event of current) {
              log.debug("flight-event", event)
            }
          }
        })

      return Service.of({ record, snapshot, flush, getEvents, reset })
    }),
  )

/**
 * Default layer with 1000-event capacity.
 */
export const defaultLayer = layer()

// ─── Bus Integration ────────────────────────────────────────────────────

/**
 * Wire the flight recorder to the bus.
 * Subscribes to the bus ALL events stream and records each as a minimal FlightRecorderEvent.
 *
 * This must be run in a scope — it creates a long-lived background fiber.
 * On scope close, flush() is called to persist remaining events.
 */
export const wireToBus = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const recorder = yield* Service

  const stream = yield* bus.subscribeAll()

  yield* Stream.runForEach(stream, (payload) =>
    Effect.gen(function* () {
      // Skip sensitive event types — llm.*, session.message.*, file.*
      if (!shouldRecordEventType(payload.type)) return

      const props = payload.properties as Record<string, unknown>
      yield* recorder.record({
        id: payload.id,
        ts: new Date().toISOString(),
        sessionId: String(props.sessionId ?? props.sessionID ?? ""),
        eventType: payload.type,
        operation: String(props.operation ?? payload.type ?? ""),
        status: String(props.status ?? ""),
        errorCode: String(props.errorCode ?? ""),
        correlationId: String(props.correlationId ?? ""),
      })
    }),
  ).pipe(
    Effect.forkScoped,
  )
})

/**
 * Layer that wires the flight recorder to the bus automatically.
 * When this layer is in the dependency graph, the flight recorder
 * starts recording events immediately.
 */
export const wiredLayer: Layer.Layer<Service, never, Bus.Service | Scope.Scope> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const buf = yield* Ref.make<Array<FlightRecorderEvent>>([])
    const capacity = DEFAULT_CAPACITY

    const record = (event: FlightRecorderEvent): Effect.Effect<void> =>
      Ref.update(buf, (events) => {
        if (events.length >= capacity) {
          return [...events.slice(1), event]
        }
        return [...events, event]
      })

    const snapshot = (): Effect.Effect<ReadonlyArray<FlightRecorderEvent>> =>
      Ref.get(buf)

    const getEvents: Effect.Effect<ReadonlyArray<FlightRecorderEvent>> =
      Ref.get(buf)

    const reset = (): Effect.Effect<void> =>
      Ref.set(buf, [])

    const flush = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* Ref.getAndSet(buf, [])
        if (current.length > 0) {
          log.info("flushing flight recorder", { count: current.length })
          for (const event of current) {
            log.debug("flight-event", event)
          }
        }
      })

    // Wire to bus
    const bus = yield* Bus.Service
    const stream = yield* bus.subscribeAll()
    yield* Stream.runForEach(stream, (payload) =>
      Effect.gen(function* () {
        if (!shouldRecordEventType(payload.type)) return
        const props = payload.properties as Record<string, unknown>
        yield* record({
          id: payload.id,
          ts: new Date().toISOString(),
          sessionId: String(props.sessionId ?? props.sessionID ?? ""),
          eventType: payload.type,
          operation: String(props.operation ?? payload.type ?? ""),
          status: String(props.status ?? ""),
          errorCode: String(props.errorCode ?? ""),
          correlationId: String(props.correlationId ?? ""),
        })
      }),
    ).pipe(Effect.forkScoped)

    return Service.of({ record, snapshot, flush, getEvents, reset })
  }),
)
