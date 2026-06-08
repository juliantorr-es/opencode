import { Duration, Effect, Layer, Schedule } from "effect"
import * as Log from "@tribunus/core/util/log"
import * as FileMemory from "../file-memory"
import { EventStore } from "../../event"

const log = Log.create({ service: "cleanup-worker" })

const FILE_MEMORY_CAP = 500
const CLEANUP_INTERVAL = Duration.seconds(60)
const EVENT_RETENTION_HOURS = 1
const MAX_PAYLOAD_SIZE = 10 * 1024

const runCleanup = Effect.gen(function* () {
  log.debug("running cleanup cycle")

  // 1. Cap FileMemory to 500 entries
  const fileMem = yield* FileMemory.Service
  const all = yield* fileMem.getAll()

  if (all.length > FILE_MEMORY_CAP) {
    const sorted = [...all].sort((a, b) => a.lastReadAt - b.lastReadAt)
    const toRemove = sorted.slice(0, sorted.length - FILE_MEMORY_CAP)

    for (const ctx of toRemove) {
      yield* fileMem.remove(ctx.path).pipe(Effect.ignore)
    }

    log.info("capped FileMemory", { removed: toRemove.length, remaining: FILE_MEMORY_CAP })
  }

  // 2. Detect oversized payloads in EventStore
  const store = yield* EventStore.Service
  const fromTs = new Date(Date.now() - EVENT_RETENTION_HOURS * 60 * 60 * 1000).toISOString()
  const events = yield* store.query({ fromTs, limit: 500, order: "desc" }).pipe(Effect.orElseSucceed(() => []))

  if (events.length > 0) {
    let largePayloads = 0
    for (const event of events) {
      if (event.payloadJson) {
        const size = JSON.stringify(event.payloadJson).length
        if (size > MAX_PAYLOAD_SIZE) largePayloads++
      }
    }
    if (largePayloads > 0) {
      log.info("large payloads detected", { count: largePayloads })
    }
  }

  // 3. Archive old raw output — log count only, never delete canonical state
  const cutoff = new Date(Date.now() - EVENT_RETENTION_HOURS * 60 * 60 * 1000)
  const oldEvents = yield* store.query({ toTs: cutoff.toISOString(), limit: 1000, order: "asc" }).pipe(Effect.orElseSucceed(() => []))

  if (oldEvents.length > 0) {
    log.info("events eligible for archival", {
      count: oldEvents.length,
      olderThan: cutoff.toISOString(),
    })
  }

  log.debug("cleanup cycle complete")
}).pipe(Effect.ignore)

export const layer = Layer.effectDiscard(
  Effect.scoped(
    Effect.gen(function* () {
      log.info("starting cleanup-worker")
      yield* runCleanup.pipe(
        Effect.repeat(Schedule.spaced(CLEANUP_INTERVAL)),
        Effect.forkScoped,
      )
      log.info("cleanup-worker fiber started")
    }),
  ),
)
