import { writeDiffContent } from "./receipts.js"
import type { OmpToolContextV1 } from "./types.js"

export function createUnifiedDiff(
  before: string,
  after: string,
  filePath: string,
  contextLines = 3,
): string {
  const a = before.split("\n")
  const b = after.split("\n")

  // Quick check: identical content
  if (before === after) return ""

  const hunks = computeHunks(a, b, contextLines)
  if (hunks.length === 0) return ""

  const header = `--- a/${filePath}\n+++ b/${filePath}\n`
  return header + hunks.join("\n")
}

type Hunk = {
  beforeStart: number
  beforeCount: number
  afterStart: number
  afterCount: number
  lines: string[]
}

function computeHunks(
  a: string[],
  b: string[],
  context: number,
): string[] {
  const ops = diffLines(a, b)
  if (ops.length === 0) return []

  const hunks: Hunk[] = []
  let i = 0

  while (i < ops.length) {
    // Skip forward to the first non-eq line
    while (i < ops.length && ops[i]!.kind === "eq") i++
    if (i >= ops.length) break

    // Expand start backward for context
    let start = i
    let ctxBefore = 0
    while (start > 0 && ctxBefore < context && ops[start - 1]!.kind === "eq") {
      start--
      ctxBefore++
    }

    // Expand end forward for context
    let end = i
    let changed = false
    while (end < ops.length) {
      if (ops[end]!.kind !== "eq") {
        changed = true
      } else if (changed) {
        // Count how many consecutive eq lines follow
        let eqCount = 0
        let peek = end
        while (peek < ops.length && ops[peek]!.kind === "eq") { eqCount++; peek++ }
        if (eqCount > context * 2) {
          // Only take context lines
          const take = Math.min(eqCount, context)
          end += take
          break
        }
      }
      end++
    }

    const hunkOps = ops.slice(start, end)

    // Count changed lines in before and after
    let beforeStart = hunkOps[0]!.beforeLine + 1
    let afterStart = hunkOps[0]!.afterLine + 1
    let beforeCount = 0
    let afterCount = 0
    const lines: string[] = []

    for (const op of hunkOps) {
      if (op.kind === "del") {
        lines.push(`-${op.line}`)
        beforeCount++
      } else if (op.kind === "add") {
        lines.push(`+${op.line}`)
        afterCount++
      } else {
        lines.push(` ${op.line}`)
        beforeCount++
        afterCount++
      }
    }

    hunks.push({ beforeStart, beforeCount, afterStart, afterCount, lines })
    i = end
  }

  return hunks.map(formatHunk)
}

function formatHunk(hunk: Hunk): string {
  const header = `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`
  return [header, ...hunk.lines].join("\n")
}

type DiffOp = { kind: "eq" | "del" | "add"; line: string; beforeLine: number; afterLine: number }

function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length

  // Compute LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
      }
    }
  }

  // Backtrack to produce diff ops
  const ops: DiffOp[] = []
  let i = n
  let j = m

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ kind: "eq", line: a[i - 1]!, beforeLine: i - 1, afterLine: j - 1 })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.unshift({ kind: "add", line: b[j - 1]!, beforeLine: i, afterLine: j - 1 })
      j--
    } else {
      ops.unshift({ kind: "del", line: a[i - 1]!, beforeLine: i - 1, afterLine: j })
      i--
    }
  }

  return ops
}

/**
 * Thin wrapper: creates a unified diff for a single file, then writes it
 * as a receipt diff artifact via receipts.ts helpers.
 */
export function writeUnifiedDiffArtifact(args: {
  receipt_id: string
  file_path: string
  before: string
  after: string
  ctx: OmpToolContextV1
}): { diff_path: string; diff_sha256: string } {
  const diff = createUnifiedDiff(args.before, args.after, args.file_path)
  const slug = args.file_path.replace(/[\/\\]/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "_")
  return writeDiffContent(args.receipt_id, `${slug}.diff`, diff, args.ctx)
}

/**
 * Thin wrapper: creates a combined unified diff across multiple files, then writes it
 * as a receipt diff artifact via receipts.ts helpers.
 */
export function writeCombinedDiffArtifact(args: {
  receipt_id: string
  files: Array<{ file_path: string; before: string; after: string }>
  ctx: OmpToolContextV1
}): { diff_path: string; diff_sha256: string } {
  const parts = args.files
    .map((f) => createUnifiedDiff(f.before, f.after, f.file_path))
    .filter((d) => d.length > 0)
  const combined = parts.join("\n")
  return writeDiffContent(args.receipt_id, "combined.diff", combined, args.ctx)
}
