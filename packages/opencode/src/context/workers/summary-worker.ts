import { Duration, Effect, Layer, Stream } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import { ContextInvalidationBus } from "../invalidation-bus"
import * as FileMemory from "../file-memory"

const log = Log.create({ service: "summary-worker" })

function extractFirstComment(content: string): string | undefined {
  const multiMatch = content.match(/\/\*\*[\s\S]*?\*\//)
  if (multiMatch) {
    const clean = multiMatch[0]
      .replace(/^\/\*\*?\s*/, "")
      .replace(/\s*\*\/$/, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean)
      .join(" ")
    if (clean.length > 0) return clean.length > 120 ? clean.slice(0, 117) + "..." : clean
  }

  const lines = content.split("\n")
  const commentLines: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("//")) {
      commentLines.push(trimmed.replace(/^\/\/\s?/, ""))
    } else if (trimmed.length > 0 && commentLines.length > 0) {
      break
    } else if (trimmed.length > 0) {
      break
    }
  }
  if (commentLines.length > 0) {
    const joined = commentLines.join(" ")
    return joined.length > 120 ? joined.slice(0, 117) + "..." : joined
  }

  return undefined
}

function summaryFromExports(ctx: FileMemory.FileContext): string {
  if (ctx.exports.length > 0) {
    const exports = ctx.exports.slice(0, 5).join(", ")
    return `exports: ${exports}${ctx.exports.length > 5 ? " …" : ""}`
  }
  if (ctx.symbols.length > 0) {
    const symbols = ctx.symbols.slice(0, 5).join(", ")
    return `defines: ${symbols}${ctx.symbols.length > 5 ? " …" : ""}`
  }
  return `file (${ctx.language})`
}

function generateSummary(path: string, content: string, ctx: FileMemory.FileContext): string {
  const comment = extractFirstComment(content)
  if (comment) return comment
  return summaryFromExports(ctx)
}

export const layer = Layer.effectDiscard(
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* ContextInvalidationBus
      log.info("starting summary-worker")

      const stream = yield* bus.subscribe("file_summary")

      yield* stream.pipe(
        Stream.debounce(Duration.seconds(1)),
        Stream.runForEach(() => runBatch),
        Effect.forkScoped,
      )

      log.info("summary-worker fiber started")
    }),
  ),
)

const runBatch = Effect.gen(function* () {
  const fileMem = yield* FileMemory.Service
  const fs = yield* AppFileSystem.Service
  const all = yield* fileMem.getAll()
  const needSummary = all.filter((ctx) => !ctx.summary || ctx.freshness === "stale")
  if (needSummary.length === 0) return

  log.info("generating summaries", { count: needSummary.length })

  for (const ctx of needSummary) {
    const content = yield* Effect.gen(function* () {
      return yield* fs.readFileString(ctx.path)
    }).pipe(Effect.orElseSucceed(() => ""))
    if (content.length === 0) continue

    const summary = generateSummary(ctx.path, content, ctx)
    yield* fileMem.set(ctx.path, { ...ctx, summary }).pipe(Effect.ignore)
    log.debug("updated summary", { file: ctx.path, summary })
  }
}).pipe(Effect.ignore)
