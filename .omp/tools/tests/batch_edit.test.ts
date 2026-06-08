import { describe, it, expect } from "bun:test"
import { validateBatchEditInput } from "../_lib/schemas"
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

const validFile = {
  path: "src/main.ts",
  expected_before_sha256: "abc123",
  edits: [{ kind: "replace_exact_once" as const, old_text: "foo", new_text: "bar" }],
}

describe("validateBatchEditInput", () => {
  it("accepts valid input with one file", () => {
    const result = validateBatchEditInput({ files: [validFile] })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.files).toHaveLength(1)
      expect(result.value.files[0].path).toBe("src/main.ts")
    }
  })

  it("accepts input with multiple files", () => {
    const result = validateBatchEditInput({
      files: [
        validFile,
        { ...validFile, path: "src/lib/util.ts" },
        { ...validFile, path: "src/lib/helper.ts" },
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.files).toHaveLength(3)
    }
  })

  it("rejects missing files array", () => {
    const result = validateBatchEditInput({})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("files")
    }
  })

  it("rejects file missing expected_before_sha256", () => {
    const { expected_before_sha256: _, ...fileMissingHash } = validFile
    const result = validateBatchEditInput({ files: [fileMissingHash] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("expected_before_sha256")
    }
  })

  it("rejects file with missing edits field", () => {
    const { edits: _, ...fileMissingEdits } = validFile
    const result = validateBatchEditInput({ files: [fileMissingEdits] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("edits")
    }
  })

  it("rejects non-string path in file", () => {
    const result = validateBatchEditInput({
      files: [{ ...validFile, path: 42 }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("path")
    }
  })

  it("accepts empty edits array (passes schema validation)", () => {
    const result = validateBatchEditInput({
      files: [{ ...validFile, edits: [] }],
    })
    expect(result.ok).toBe(true)
  })
})

describe("path policy — multiple paths, one denied", () => {
  const ctx = makeContext()

  it("should refuse when one of multiple paths is denied", () => {
    const paths = [
      { input: "src/lib/safe.ts", expectOk: true },
      { input: "src/.env", expectOk: false },
      { input: "src/lib/another.ts", expectOk: true },
    ]

    const denied: string[] = []
    for (const p of paths) {
      const decision = resolveWritePath(p.input, ctx)
      if (!decision.ok) {
        denied.push(p.input)
      }
    }

    expect(denied).toContain("src/.env")
    expect(denied).toHaveLength(1)
  })
})

describe("sha256 — deterministic", () => {
  it("produces the same hash for identical content", () => {
    const content = "console.log('hello world');\n"
    const a = sha256(content)
    const b = sha256(content)
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
  })
})
