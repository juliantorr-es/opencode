import { Effect } from "effect"
import type { SessionID } from "@/session/schema"
import { assembleDebugPacket } from "./debug-packet"
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js"
import path from "path"
import os from "os"
import fs from "fs/promises"

/**
 * Result of a debug packet export.
 */
export interface ExportResult {
  path: string
  size: number
}

export interface ExportOptions {
  includeGitDiff?: boolean
  includeDuckDbQueries?: boolean
  outputDir?: string
}

/**
 * Helper: serialize a value to pretty-printed JSON safely.
 * Falls back to {"error":"serialization failed"} on circular refs etc.
 */
function safeJson(value: unknown, fallbackLabel = "data"): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return JSON.stringify({ error: `Failed to serialize ${fallbackLabel}` }, null, 2)
  }
}

/**
 * Helper: build a safe JSONL string from an array of objects.
 */
function toJsonl(items: unknown[], label = "items"): string {
  try {
    return items.map((item) => JSON.stringify(item)).join("\n") + "\n"
  } catch {
    return JSON.stringify({ error: `Failed to serialize ${label}` }) + "\n"
  }
}

/**
 * Export a debug packet for a session as a zip file.
 *
 * The zip contains:
 *   debug-packet/
 *     session.json          — Session metadata
 *     events.jsonl          — All runtime events as JSONL
 *     tool-calls.json       — Tool call summaries
 *     file-edits.json       — File edit summaries
 *     permissions.json      — Permission decisions
 *     lifecycle.json        — Lifecycle transitions
 *     mcp-events.json       — MCP server events
 *     errors.json           — Normalized errors
 *     redacted-config.json  — Config summary (redacted)
 *     git-diff.diff         — Optional git diff
 *     duckdb-queries.json   — Optional DuckDB query results
 */
export const exportDebugPacket = (sessionId: SessionID, options?: ExportOptions) =>
  Effect.gen(function* () {
    const outputDir = options?.outputDir ?? os.tmpdir()

    // 1. Assemble the packet data
    const packet = yield* assembleDebugPacket(sessionId, {
      includeGitDiff: options?.includeGitDiff,
      includeDuckDbQueries: options?.includeDuckDbQueries,
    })

    // 2. Extract sub-sections with safe fallbacks
    const sessionData = packet.session
    const eventsData = sessionData.runtimeEvents ?? []
    const toolCallsData = sessionData.toolCalls ?? []
    const fileEditsData = sessionData.fileEdits ?? []
    const permissionsData = sessionData.permissionDecisions ?? []
    const lifecycleData = sessionData.lifecycleTransitions ?? []
    const mcpEventsData = sessionData.mcpEvents ?? []
    const errorsData = sessionData.errors ?? []

    // 3. Build zip (wrapped in tryPromise since @zip.js/zip.js is async)
    const prefix = "debug-packet/"

    const buffer = yield* Effect.tryPromise({
      try: async () => {
        const zipWriter = new ZipWriter(new BlobWriter("application/zip"))

        // session metadata
        await zipWriter.add(prefix + "session.json", new TextReader(safeJson(sessionData.metadata ?? {}, "session")))
        // runtime events as JSONL
        await zipWriter.add(prefix + "events.jsonl", new TextReader(toJsonl(eventsData, "events")))
        // individual JSON files for structured data
        await zipWriter.add(prefix + "tool-calls.json", new TextReader(safeJson(toolCallsData, "tool-calls")))
        await zipWriter.add(prefix + "file-edits.json", new TextReader(safeJson(fileEditsData, "file-edits")))
        await zipWriter.add(prefix + "permissions.json", new TextReader(safeJson(permissionsData, "permissions")))
        await zipWriter.add(prefix + "lifecycle.json", new TextReader(safeJson(lifecycleData, "lifecycle")))
        await zipWriter.add(prefix + "mcp-events.json", new TextReader(safeJson(mcpEventsData, "mcp-events")))
        await zipWriter.add(prefix + "errors.json", new TextReader(safeJson(errorsData, "errors")))
        await zipWriter.add(prefix + "redacted-config.json", new TextReader(safeJson(packet.redactedConfig, "config")))

        // optional git diff
        if (packet.gitDiff) {
          await zipWriter.add(prefix + "git-diff.diff", new TextReader(packet.gitDiff))
        }

        // optional duckdb queries
        if (packet.duckDbQueries) {
          await zipWriter.add(prefix + "duckdb-queries.json", new TextReader(safeJson(packet.duckDbQueries, "duckdb")))
        }

        // 4. Close zip and get buffer
        const blob = await zipWriter.close()
        const arrayBuffer = await blob.arrayBuffer()
        return Buffer.from(arrayBuffer)
      },
      catch: (err) => new Error(`Failed to create zip: ${err instanceof Error ? err.message : String(err)}`),
    })

    // 5. Write to disk
    const filename = `debug-session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.zip`
    const filePath = path.join(outputDir, filename)
    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, buffer)
      },
      catch: (err) => new Error(`Failed to write zip file: ${err instanceof Error ? err.message : String(err)}`),
    })

    return { path: filePath, size: buffer.length } satisfies ExportResult
  })
