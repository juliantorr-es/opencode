import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import { allocateReceiptPath, buildReceipt, writeReceipt } from "../_lib/receipts"
import { buildToolContext } from "../_lib/tool-context"
import type { OmpToolContextV1, OmpToolReceiptV1 } from "../_lib/types"

// ── Test helpers ──

let testDir: string

function freshCtx(): OmpToolContextV1 {
  testDir = resolve(tmpdir(), `receipts-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(testDir, { recursive: true })
    return buildToolContext({ cwd: testDir, repoRoot: testDir })
}

function cleanup(): void {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true })
  }
}

const stubFiles: OmpToolReceiptV1["files"] = [
  { path: "src/main.ts", action: "read" },
]

function baseOpts(ctx: OmpToolContextV1, receiptPath: string) {
  return {
    receipt_id: "test-001",
    invocation_id: "inv-abc123",
    tool_id: "test-tool",
    tool_version: "1.0.0",
    ctx,
    input_sha256: "a".repeat(64),
    normalized_input_sha256: "b".repeat(64),
    files: stubFiles,
    summary: "test receipt",
    diff_paths: [],
    hash_precondition_satisfied: true,
    receipt_path: receiptPath,
  }
}

// ── allocateReceiptPath ──

describe("allocateReceiptPath", () => {
  it("returns a dated path under receipts_dir", () => {
    const ctx = freshCtx()
    try {
      const path = allocateReceiptPath("test-001", ctx)
      expect(path).toMatch(/evidence\/receipts\/\d{4}-\d{2}-\d{2}\/test-001\.json$/)
    } finally {
      cleanup()
    }
  })

  it("includes the current date in YYYY-MM-DD format", () => {
    const ctx = freshCtx()
    try {
      const now = new Date()
      const yyyymmdd =
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
      const path = allocateReceiptPath("receipt-abc", ctx)
      expect(path).toContain(yyyymmdd)
    } finally {
      cleanup()
    }
  })
})

// ── buildReceipt ──

describe("buildReceipt", () => {
  it("populates all required fields", () => {
    const ctx = freshCtx()
    try {
      const receiptPath = "/tmp/some/receipt.json"
      const opts = baseOpts(ctx, receiptPath)
      const receipt = buildReceipt(opts)

      expect(receipt.schema).toBe("omp.tool.receipt.v1")
      expect(receipt.receipt_id).toBe("test-001")
      expect(receipt.invocation_id).toBe("inv-abc123")
      expect(receipt.tool_id).toBe("test-tool")
      expect(receipt.tool_version).toBe("1.0.0")
      expect(receipt.created_at).toBeTruthy()
      expect(typeof receipt.created_at).toBe("string")
      expect(receipt.cwd).toBe(ctx.cwd)
      expect(receipt.actor).toEqual(ctx.actor)
      expect(receipt.command.input_sha256).toBe(opts.input_sha256)
      expect(receipt.command.normalized_input_sha256).toBe(opts.normalized_input_sha256)
      expect(receipt.authority.risk_level).toBe("read")
      expect(receipt.authority.requires_hash_precondition).toBe(true)
      expect(receipt.authority.hash_precondition_satisfied).toBe(true)
      expect(receipt.authority.path_policy_satisfied).toBe(true)
      expect(receipt.files).toEqual(stubFiles)
      expect(receipt.result.status).toBe("ok")
      expect(receipt.result.summary).toBe("test receipt")
    } finally {
      cleanup()
    }
  })

  it("receipt_path in artifacts matches what was passed", () => {
    const ctx = freshCtx()
    try {
      const receiptPath = "/custom/path/receipt.json"
      const receipt = buildReceipt(baseOpts(ctx, receiptPath))
      expect(receipt.artifacts.receipt_path).toBe(receiptPath)
    } finally {
      cleanup()
    }
  })

  it("sets created_at to a valid ISO string", () => {
    const ctx = freshCtx()
    try {
      const receipt = buildReceipt(baseOpts(ctx, "/some/path.json"))
      const parsed = new Date(receipt.created_at)
      expect(parsed.getTime()).not.toBeNaN()
    } finally {
      cleanup()
    }
  })
})

// ── writeReceipt ──

describe("writeReceipt", () => {
  it("creates the receipt file on disk", () => {
    const ctx = freshCtx()
    try {
      const receiptPath = resolve(testDir, "evidence", "receipts", "test-001.json")
      const receipt = buildReceipt(baseOpts(ctx, receiptPath))
      writeReceipt(receipt, receiptPath)
      expect(existsSync(receiptPath)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it("creates parent directories when they don't exist", () => {
    const ctx = freshCtx()
    try {
      const deepPath = resolve(testDir, "a", "b", "c", "receipt.json")
      const receipt = buildReceipt(baseOpts(ctx, deepPath))
      writeReceipt(receipt, deepPath)
      expect(existsSync(deepPath)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it("written JSON is valid and matches the input receipt", () => {
    const ctx = freshCtx()
    try {
      const receiptPath = resolve(testDir, "receipt.json")
      const receipt = buildReceipt(baseOpts(ctx, receiptPath))
      writeReceipt(receipt, receiptPath)

      const raw = readFileSync(receiptPath, "utf8")
      const parsed: OmpToolReceiptV1 = JSON.parse(raw)
      expect(parsed.schema).toBe("omp.tool.receipt.v1")
      expect(parsed.receipt_id).toBe(receipt.receipt_id)
      expect(parsed.created_at).toBe(receipt.created_at)
      expect(parsed.artifacts.receipt_path).toBe(receiptPath)
      expect(parsed.result.summary).toBe("test receipt")
    } finally {
      cleanup()
    }
  })
})
