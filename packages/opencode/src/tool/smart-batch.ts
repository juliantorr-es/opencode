import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./smart-batch.txt"

interface EditItem {
  file: string
  oldText: string
  newText: string
  reason?: string
}

interface Snapshot {
  file: string
  original: string
  reason: string
}

interface WriteTarget {
  file: string
  content: string
  edit: EditItem
  index: number
}

const Parameters = Schema.Struct({
  edits: Schema.String.annotate({
    description:
      'JSON array of edit objects: [{"file":"...","oldText":"...","newText":"...","reason":"..."}]',
  }),
  plan_step: Schema.optional(Schema.String).annotate({
    description: "Which plan step these edits correspond to",
  }),
})

export const SmartBatchTool = Tool.define(
  "smart_batch",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context

          // Parse the edits JSON string
          let edits: EditItem[]
          try {
            const parsed = JSON.parse(params.edits)
            if (!Array.isArray(parsed) || parsed.length === 0) {
              throw new Error("edits must be a non-empty JSON array")
            }
            edits = parsed as EditItem[]
          } catch (e) {
            throw new Error(
              `Failed to parse edits: ${e instanceof Error ? e.message : String(e)}`,
            )
          }

          // ── Phase 1: Validate all edits and build write targets ──────────
          const originals = new Map<string, string>() // immutable snapshots for rollback
          const working = new Map<string, string>() // mutable working copy
          const writes: WriteTarget[] = []

          for (const [i, edit] of edits.entries()) {
            const filePath = path.isAbsolute(edit.file)
              ? edit.file
              : path.join(instance.directory, edit.file)

            // Read file content (lazy — read once per unique file)
            if (!working.has(filePath)) {
              const exists = yield* fs.existsSafe(filePath)
              if (!exists) {
                yield* Effect.sync(() => originals.clear())
                throw new Error(
                  `Edit ${i}: file not found — ${edit.file}`,
                )
              }
              const content = yield* fs.readFileString(filePath)
              originals.set(filePath, content)
              working.set(filePath, content)
            }

            const current = working.get(filePath)!
            const count = current.split(edit.oldText).length - 1

            if (count === 0) {
              yield* Effect.sync(() => originals.clear())
              throw new Error(
                `Edit ${i}: oldText not found in ${edit.file} — check exact whitespace and line endings`,
              )
            }

            if (count > 1) {
              yield* Effect.sync(() => originals.clear())
              throw new Error(
                `Edit ${i}: oldText matches ${count} times in ${edit.file} — must be unique. Include more surrounding context.`,
              )
            }

            const modified = current.replace(edit.oldText, edit.newText)
            working.set(filePath, modified)
            writes.push({ file: filePath, content: modified, edit, index: i })
          }

          // ── Phase 2: Write all files atomically ──────────────────────────
          const writtenFiles: string[] = []

          try {
            for (const w of writes) {
              yield* fs.ensureDir(path.dirname(w.file))
              yield* fs.writeFileString(w.file, w.content)
              writtenFiles.push(w.file)
            }
          } catch (error) {
            // Atomic rollback: restore every previously written file to its original content
            const seen = new Set<string>()
            for (const file of writtenFiles) {
              if (seen.has(file)) continue
              seen.add(file)
              const original = originals.get(file)
              if (original !== undefined) {
                yield* fs.writeFileString(file, original).pipe(
                  Effect.catch(() =>
                    Effect.logWarning("Failed to restore original during rollback", { file }),
                  ),
                )
              }
            }
            throw new Error(
              `Batch edit failed at edit ${writes.length > 0 ? writes[writtenFiles.length]?.index ?? "?" : "?"}: ${error instanceof Error ? error.message : String(error)}`,
            )
          }

          // ── Phase 3: Record edit metadata ────────────────────────────────
          const editsDir = path.join(
            instance.directory,
            "docs",
            "json",
            "opencode",
            "sessions",
            ctx.sessionID,
            "edits",
          )
          const logPath = path.join(editsDir, "edit_log.v1.jsonl")
          yield* fs.ensureDir(editsDir)

          for (const w of writes) {
            const snapshot = originals.get(w.file)
            const changed = snapshot !== undefined && snapshot !== w.content
            const record = {
              schema_version: "v1",
              session_id: ctx.sessionID,
              agent: ctx.agent,
              file: w.file,
              reason: w.edit.reason ?? "batch edit",
              change_summary: `batch edit ${w.index + 1}/${edits.length}${changed ? "" : " (no change)"}`,
              plan_step: params.plan_step ?? null,
              edited_at: new Date().toISOString(),
            }
            yield* fs.appendLine(logPath, JSON.stringify(record))
          }

          const result = {
            status: "applied",
            total: edits.length,
            files: writes.map((w) => w.file),
            metadata_recorded: true,
          }

          return {
            title: "smart_batch",
            metadata: {
              edits_applied: writes.length,
              total: edits.length,
              files: writes.map((w) => w.file),
            },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SmartBatch from "./smart-batch"
