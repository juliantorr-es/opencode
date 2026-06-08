import { describe, it, expect } from "bun:test"
import { validateTextReplaceInput } from "../_lib/schemas"
import { resolveWritePath } from "../_lib/path-policy"
import { sha256 } from "../_lib/hashing"
import type { OmpToolContextV1 } from "../_lib/types"

function makeContext(overrides?: Partial<OmpToolContextV1>): OmpToolContextV1 {
  return {
    cwd: "/test/repo",
    repo_root: "/test/repo",
    mode: "loose",
    actor: { kind: "agent", session_id: "test" },
    limits: { max_file_bytes: 1048576, max_output_bytes: 1048576, max_files_touched: 100 },
    paths: {
      receipts_dir: "/test/repo/.omp/evidence/receipts",
      diffs_dir: "/test/repo/.omp/evidence/diffs",
      events_path: "/test/repo/.omp/evidence/events/events.jsonl",
      journals_dir: "/test/repo/.omp/evidence/journals",
    },
    ...overrides,
  }
}

describe("validateTextReplaceInput", () => {
  it("accepts valid input", () => {
    const result = validateTextReplaceInput({
      path: "src/main.ts",
      expected_before_sha256: "abc123",
      old_text: "foo",
      new_text: "bar",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.path).toBe("src/main.ts")
      expect(result.value.expected_before_sha256).toBe("abc123")
      expect(result.value.old_text).toBe("foo")
      expect(result.value.new_text).toBe("bar")
    }
  })

  it("rejects missing expected_before_sha256", () => {
    const result = validateTextReplaceInput({
      path: "src/main.ts",
      old_text: "foo",
      new_text: "bar",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("expected_before_sha256")
    }
  })

  it("rejects missing path", () => {
    const result = validateTextReplaceInput({
      expected_before_sha256: "abc",
      old_text: "foo",
      new_text: "bar",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("path")
    }
  })

  it("rejects missing old_text", () => {
    const result = validateTextReplaceInput({
      path: "src/main.ts",
      expected_before_sha256: "abc",
      new_text: "bar",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("old_text")
    }
  })
})

describe("path policy — resolveWritePath", () => {
  const ctx = makeContext()

  it("denies .env", () => {
    const decision = resolveWritePath(".env", ctx)
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.denied_pattern).toBe(".env")
    }
  })

  it("denies parent directory traversal (../)", () => {
    const decision = resolveWritePath("../outside", ctx)
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.denied_pattern).toBe("<escape>")
    }
  })
})

describe("sha256", () => {
  it("produces a 64-character hex string", () => {
    const hash = sha256("hello world")
    expect(hash).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true)
  })
})
