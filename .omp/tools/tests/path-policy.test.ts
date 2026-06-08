import { describe, it, expect } from "bun:test"
import { resolveReadPath, resolveWritePath } from "../_lib/path-policy"
import { buildToolContext } from "../_lib/tool-context"
import type { PathPolicyDecisionV1, OmpToolContextV1 } from "../_lib/types"

function ctx(): OmpToolContextV1 {
  return buildToolContext({ cwd: "/tmp/test-repo" })
}

// ── helpers ──

function ok(result: PathPolicyDecisionV1): string {
  expect(result.ok).toBe(true)
  return result.normalized_path!
}

function denied(result: PathPolicyDecisionV1): string {
  expect(result.ok).toBe(false)
  return result.denied_pattern!
}

// ── resolveReadPath ──

describe("resolveReadPath", () => {
  it("resolves a normal repo-relative path", () => {
    const r = resolveReadPath("src/main.ts", ctx())
    expect(ok(r)).toBe("src/main.ts")
  })

  it("denies absolute path", () => {
    const r = resolveReadPath("/etc/passwd", ctx())
    expect(denied(r)).toBe("<absolute>")
  })

  it("denies parent traversal that escapes repo root", () => {
    const r = resolveReadPath("../outside/file.ts", ctx())
    expect(denied(r)).toBe("<escape>")
  })

  it("denies .env exact match", () => {
    const r = resolveReadPath(".env", ctx())
    expect(denied(r)).toBe(".env")
  })

  it("denies .env.* glob pattern", () => {
    const r = resolveReadPath(".env.production", ctx())
    expect(denied(r)).toBe(".env.*")
  })

  it("allows a normal nested path", () => {
    const r = resolveReadPath("packages/app/README.md", ctx())
    expect(ok(r)).toBe("packages/app/README.md")
  })

  it("allows .git/ directories for reads", () => {
    const r = resolveReadPath(".git/HEAD", ctx())
    expect(ok(r)).toBe(".git/HEAD")
  })

  it("allows node_modules/ for reads", () => {
    const r = resolveReadPath("node_modules/foo/index.js", ctx())
    expect(ok(r)).toBe("node_modules/foo/index.js")
  })
})

// ── resolveWritePath ──

describe("resolveWritePath", () => {
  it("resolves a normal repo-relative path", () => {
    const r = resolveWritePath("src/main.ts", ctx())
    expect(ok(r)).toBe("src/main.ts")
  })

  it("denies absolute path", () => {
    const r = resolveWritePath("/etc/passwd", ctx())
    expect(denied(r)).toBe("<absolute>")
  })

  it("denies parent traversal that escapes repo root", () => {
    const r = resolveWritePath("../outside/file.ts", ctx())
    expect(denied(r)).toBe("<escape>")
  })

  it("denies .git/ segment", () => {
    const r = resolveWritePath(".git/config", ctx())
    expect(denied(r)).toBe(".git/")
  })

  it("denies node_modules/ segment", () => {
    const r = resolveWritePath("node_modules/pkg/index.js", ctx())
    expect(denied(r)).toBe("node_modules/")
  })

  it("denies .env exact match", () => {
    const r = resolveWritePath(".env", ctx())
    expect(denied(r)).toBe(".env")
  })

  it("denies .env.production glob pattern", () => {
    const r = resolveWritePath(".env.production", ctx())
    expect(denied(r)).toBe(".env.*")
  })

  it("denies .omp/evidence/receipts/ artifact path", () => {
    const r = resolveWritePath(".omp/evidence/receipts/001-receipt.json", ctx())
    expect(denied(r)).toBe(".omp/evidence/receipts/")
  })

  it("denies .omp/evidence/diffs/ artifact path", () => {
    const r = resolveWritePath(".omp/evidence/diffs/001/diff.diff", ctx())
    expect(denied(r)).toBe(".omp/evidence/diffs/")
  })

  it("denies .omp/evidence/events/ artifact path", () => {
    const r = resolveWritePath(".omp/evidence/events/tool-events.jsonl", ctx())
    expect(denied(r)).toBe(".omp/evidence/events/")
  })

  it("denies .omp/evidence/journals/ artifact path", () => {
    const r = resolveWritePath(".omp/evidence/journals/001-journal.json", ctx())
    expect(denied(r)).toBe(".omp/evidence/journals/")
  })

  it("allows a normal nested path for writes", () => {
    const r = resolveWritePath("packages/app/src/util.ts", ctx())
    expect(ok(r)).toBe("packages/app/src/util.ts")
  })
})
