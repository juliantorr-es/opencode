import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { sha256 } from "./hashing.js"
import { createUnifiedDiff } from "./diff.js"
import type { OmpToolReceiptV1, OmpToolContextV1 } from "./types.js"

/**
 * Allocate a dated receipt path under `<ctx.paths.receipts_dir>/<YYYY-MM-DD>/<receiptId>.json`.
 */
export function allocateReceiptPath(receiptId: string, ctx: OmpToolContextV1): string {
  const now = new Date()
  const yyyymmdd =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  return resolve(ctx.paths.receipts_dir, yyyymmdd, `${receiptId}.json`)
}

/**
 * Build a complete OmpToolReceiptV1. All fields are provided at construction time;
 * the caller does NOT need to mutate the receipt after receiving it.
 */
export function buildReceipt(opts: {
  receipt_id: string
  invocation_id: string
  tool_id: string
  tool_version: string
  ctx: OmpToolContextV1
  input_sha256: string
  normalized_input_sha256: string
  input_redacted_preview?: unknown
  files: OmpToolReceiptV1["files"]
  summary: string
  diff_paths: string[]
  journal_path?: string
  hash_precondition_satisfied: boolean
  receipt_path: string
}): OmpToolReceiptV1 {
  const now = new Date().toISOString()
  return {
    schema: "omp.tool.receipt.v1",
    receipt_id: opts.receipt_id,
    invocation_id: opts.invocation_id,
    tool_id: opts.tool_id,
    tool_version: opts.tool_version,
    created_at: now,
    cwd: opts.ctx.cwd,
    actor: opts.ctx.actor,
    command: {
      input_sha256: opts.input_sha256,
      normalized_input_sha256: opts.normalized_input_sha256,
      input_redacted_preview: opts.input_redacted_preview,
    },
    authority: {
      risk_level: "read",
      requires_hash_precondition: true,
      hash_precondition_satisfied: opts.hash_precondition_satisfied,
      path_policy_satisfied: true,
    },
    files: opts.files,
    result: {
      status: "ok",
      summary: opts.summary,
    },
    artifacts: {
      receipt_path: opts.receipt_path,
      diff_paths: opts.diff_paths,
      journal_path: opts.journal_path,
      event_path: opts.ctx.paths.events_path,
    },
    integrity: {},
  }
}

/**
 * Write a receipt JSON file, creating parent directories as needed.
 */
export function writeReceipt(receipt: OmpToolReceiptV1, path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(receipt, null, 2), "utf8")
}

/**
 * Allocate the diff directory for a receipt: `<ctx.paths.diffs_dir>/<receiptId>/`.
 */
export function allocateDiffDir(receiptId: string, ctx: OmpToolContextV1): string {
  return resolve(ctx.paths.diffs_dir, `${receiptId}/`)
}

/**
 * Write a single-file diff artifact to `<diffDir>/<safe_file_slug>.diff`.
 * Returns the absolute diff path and its SHA-256.
 */
export function writeDiffArtifact(
  receiptId: string,
  filePath: string,
  before: string,
  after: string,
  ctx: OmpToolContextV1,
): { diff_path: string; diff_sha256: string } {
  const slug = filePath.replace(/[\/\\]/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "_")
  const diffDir = resolve(ctx.paths.diffs_dir, receiptId)
  if (!existsSync(diffDir)) mkdirSync(diffDir, { recursive: true })
  const diffPath = resolve(diffDir, `${slug}.diff`)

  const diff = createUnifiedDiff(before, after, filePath)
  writeFileSync(diffPath, diff, "utf8")
  return { diff_path: diffPath, diff_sha256: sha256(diff) }
}

/**
 * Write a combined diff artifact (all files in one .diff) to `<diffDir>/combined.diff`.
 * Returns the absolute diff path and its SHA-256.
 */
export function writeCombinedDiffArtifact(
  receiptId: string,
  files: Array<{ file_path: string; before: string; after: string }>,
  ctx: OmpToolContextV1,
): { diff_path: string; diff_sha256: string } {
  const diffDir = resolve(ctx.paths.diffs_dir, receiptId)
  if (!existsSync(diffDir)) mkdirSync(diffDir, { recursive: true })
  const diffPath = resolve(diffDir, "combined.diff")

  const parts = files
    .map((f) => createUnifiedDiff(f.before, f.after, f.file_path))
    .filter((d) => d.length > 0)
  const combined = parts.join("\n")

  writeFileSync(diffPath, combined, "utf8")
  return { diff_path: diffPath, diff_sha256: sha256(combined) }
}

/**
 * Write raw diff content to a file within a receipt's diff directory.
 * Lower-level helper used by diff.ts thin wrappers.
 */
export function writeDiffContent(
  receiptId: string,
  fileName: string,
  content: string,
  ctx: OmpToolContextV1,
): { diff_path: string; diff_sha256: string } {
  const diffDir = resolve(ctx.paths.diffs_dir, receiptId)
  if (!existsSync(diffDir)) mkdirSync(diffDir, { recursive: true })
  const diffPath = resolve(diffDir, fileName)
  writeFileSync(diffPath, content, "utf8")
  return { diff_path: diffPath, diff_sha256: sha256(content) }
}
