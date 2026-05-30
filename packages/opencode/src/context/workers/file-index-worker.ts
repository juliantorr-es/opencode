import { Duration, Effect, Layer, Stream } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import { ContextInvalidationBus } from "../invalidation-bus"
import * as FileMemory from "../file-memory"

const log = Log.create({ service: "file-index-worker" })

export const layer = Layer.effectDiscard(
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* ContextInvalidationBus
      log.info("starting file-index-worker")

      const s1 = yield* bus.subscribe("file_summary")
      const s2 = yield* bus.subscribe("file_digests")
      const s3 = yield* bus.subscribe("symbol_outline")

      const merged = Stream.mergeAll({ concurrency: "unbounded" })([s1, s2, s3])

      yield* merged.pipe(
        Stream.debounce(Duration.millis(500)),
        Stream.runForEach(() => runBatch),
        Effect.forkScoped,
      )

      log.info("file-index-worker fiber started")
    }),
  ),
)

const runBatch = Effect.gen(function* () {
  const fileMem = yield* FileMemory.Service
  const fs = yield* AppFileSystem.Service
  const stale = yield* fileMem.getStale()
  if (!stale || stale.length === 0) return

  log.info("re-indexing stale files", { count: stale.length })

  for (const filePath of stale) {
    const content = yield* Effect.gen(function* () {
      return yield* fs.readFileString(filePath)
    }).pipe(Effect.orElseSucceed(() => ""))
    if (content.length === 0) continue

    yield* fileMem.refresh(filePath, content).pipe(Effect.ignore)
    log.debug("re-indexed file", { file: filePath })
  }
}).pipe(Effect.ignore)
