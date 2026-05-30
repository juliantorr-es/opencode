import { Duration, Effect, Layer, Stream } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { ContextInvalidationBus } from "../invalidation-bus"
import * as ValidationContext from "../validation-context"
import { EventStore } from "../../event"

const log = Log.create({ service: "validation-parser-worker" })

function extractTestName(event: any): string {
  if (event.payloadJson) {
    const p = event.payloadJson as Record<string, unknown>
    if (typeof p.testName === "string") return p.testName
    if (typeof p.test_name === "string") return p.test_name
    if (typeof p.name === "string") return p.name
  }
  if (event.errorMessage) {
    const match = event.errorMessage.match(/(?:test|suite)\s+['"]([^'"]+)['"]/i)
    if (match) return match[1]
  }
  return "unknown"
}

function extractFilePath(event: any): string {
  if (event.filePath) return event.filePath
  if (event.payloadJson) {
    const p = event.payloadJson as Record<string, unknown>
    if (typeof p.file === "string") return p.file
    if (typeof p.filePath === "string") return p.filePath
    if (typeof p.file_path === "string") return p.file_path
  }
  return "unknown"
}

function extractLine(event: any): number | undefined {
  if (event.payloadJson) {
    const p = event.payloadJson as Record<string, unknown>
    if (typeof p.line === "number") return p.line
    if (typeof p.lineNumber === "number") return p.lineNumber
    if (typeof p.line_number === "number") return p.line_number
  }
  if (event.errorMessage) {
    const match = event.errorMessage.match(/:(\d+)(?::\d+)?(?:\])?$/m)
    if (match) return parseInt(match[1], 10)
    const parenMatch = event.errorMessage.match(/\(([^)]+):(\d+):\d+\)/)
    if (parenMatch) return parseInt(parenMatch[2], 10)
  }
  return undefined
}

export const layer = Layer.effectDiscard(
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* ContextInvalidationBus
      log.info("starting validation-parser-worker")

      const stream = yield* bus.subscribe("validation_clean_state")

      yield* stream.pipe(
        Stream.debounce(Duration.millis(500)),
        Stream.runForEach(() => runBatch),
        Effect.forkScoped,
      )

      log.info("validation-parser-worker fiber started")
    }),
  ),
)

const runBatch = Effect.gen(function* () {
  const vc = yield* ValidationContext.Service
  const eventStore = yield* EventStore.Service

  const fromTs = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const events = yield* (
    Effect.gen(function* () {
      return yield* eventStore.query({
        status: "failed",
        fromTs,
        order: "desc",
        limit: 200,
      })
    }).pipe(Effect.orElseSucceed(() => []))
  )

  if (events.length === 0) {
    yield* vc.clear()
    return
  }

  const failures = events.map((e: any) => ({
    testName: extractTestName(e),
    file: extractFilePath(e),
    line: extractLine(e),
    message: e.errorMessage ?? e.eventType,
    sessionId: e.sessionId ?? "",
    timestamp: e.ts,
  }))

  yield* vc.setFailures(failures)
  log.info("updated validation context", { failureCount: failures.length })
}).pipe(Effect.ignore)
