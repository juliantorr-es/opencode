import { describe, it, expect } from "bun:test"
import { validateStructReadInput } from "../_lib/schemas"
import { resolveReadPath } from "../_lib/path-policy"
import { buildToolContext } from "../_lib/tool-context"
import { sha256, fileSha256 } from "../_lib/hashing"
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

function ctx() {
  return buildToolContext({ cwd: "/tmp/test-repo" })
}

// ── validateStructReadInput ──

describe("validateStructReadInput", () => {
  it("accepts minimal valid input (just path)", () => {
    const r = validateStructReadInput({ path: "src/main.ts" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.path).toBe("src/main.ts")
    }
  })

  it("accepts focus mode with symbol_name", () => {
    const r = validateStructReadInput({ path: "src/main.ts", mode: "focus", symbol_name: "MyClass" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.mode).toBe("focus")
      expect(r.value.symbol_name).toBe("MyClass")
    }
  })

  it("accepts all valid modes", () => {
    const modes = ["full", "head", "range", "symbols", "focus"] as const
    for (const mode of modes) {
      const r = validateStructReadInput({ path: "src/main.ts", mode })
      expect(r.ok).toBe(true)
    }
  })

  it("rejects invalid mode", () => {
    const r = validateStructReadInput({ path: "src/main.ts", mode: "invalid" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/mode/)
    }
  })

  it("rejects invalid mode type (number)", () => {
    const r = validateStructReadInput({ path: "src/main.ts", mode: 42 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/mode/)
    }
  })

  it("rejects missing path", () => {
    const r = validateStructReadInput({})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/path/)
    }
  })

  it("rejects non-string path", () => {
    const r = validateStructReadInput({ path: 42 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/path/)
    }
  })

  it("validates start_line type", () => {
    const r = validateStructReadInput({ path: "x.ts", start_line: "abc" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/start_line/)
    }
  })

  it("validates end_line type", () => {
    const r = validateStructReadInput({ path: "x.ts", end_line: "abc" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/end_line/)
    }
  })

  it("validates symbol_name type", () => {
    const r = validateStructReadInput({ path: "x.ts", symbol_name: 42 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/symbol_name/)
    }
  })

  it("validates max_bytes type", () => {
    const r = validateStructReadInput({ path: "x.ts", max_bytes: "big" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/max_bytes/)
    }
  })

  it("validates max_lines type", () => {
    const r = validateStructReadInput({ path: "x.ts", max_lines: "lots" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/max_lines/)
    }
  })

  it("validates include_sha256 type", () => {
    const r = validateStructReadInput({ path: "x.ts", include_sha256: "yes" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/include_sha256/)
    }
  })

  it("validates include_line_numbers type", () => {
    const r = validateStructReadInput({ path: "x.ts", include_line_numbers: "yes" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/include_line_numbers/)
    }
  })

  it("accepts focus mode without symbol_name (no cross-field validation at schema level)", () => {
    // The schema validator checks individual field types but does not
    // cross-validate mode + symbol_name combinations. This test asserts
    // that the combination is accepted at the schema level; the actual
    // enforcement happens in the struct_read.ts handler at runtime.
    const r = validateStructReadInput({ path: "src/main.ts", mode: "focus" })
    // The validator accepts this structurally (no cross-field rule)
    expect(r.ok).toBe(true)
  })

  it("rejects non-object input", () => {
    const r = validateStructReadInput("not an object")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/non-null object/)
    }
  })

  it("rejects null input", () => {
    const r = validateStructReadInput(null)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/non-null object/)
    }
  })

  it("accepts all optional fields with correct types", () => {
    const r = validateStructReadInput({
      path: "x.ts",
      mode: "range",
      start_line: 10,
      end_line: 20,
      symbol_name: "foo",
      max_bytes: 1024,
      max_lines: 50,
      include_sha256: true,
      include_line_numbers: false,
    })
    expect(r.ok).toBe(true)
  })
})

// ── Path policy (resolveReadPath) ──

describe("resolveReadPath path policy", () => {
  it("denies .env", () => {
    const r = resolveReadPath(".env", ctx())
    expect(r.ok).toBe(false)
    expect(r.denied_pattern).toBe(".env")
  })

  it("denies .env.* pattern", () => {
    const r = resolveReadPath(".env.production", ctx())
    expect(r.ok).toBe(false)
    expect(r.denied_pattern).toBe(".env.*")
  })

  it("denies *.pem files", () => {
    const r = resolveReadPath("secret.pem", ctx())
    expect(r.ok).toBe(false)
    expect(r.denied_pattern).toBe("*.pem")
  })

  it("denies *.key files", () => {
    const r = resolveReadPath("id_rsa.key", ctx())
    expect(r.ok).toBe(false)
    expect(r.denied_pattern).toBe("*.key")
  })

  it("allows normal .ts files", () => {
    const r = resolveReadPath("src/main.ts", ctx())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.normalized_path).toBe("src/main.ts")
    }
  })

  it("allows normal nested .ts files", () => {
    const r = resolveReadPath("packages/app/src/utils.ts", ctx())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.normalized_path).toBe("packages/app/src/utils.ts")
    }
  })
})

// ── sha256 ──

describe("sha256", () => {
  it("sha256 of a sample file matches expected", () => {
    const tmp = mkdtempSync(join(tmpdir(), "struct-read-test-"))
    try {
      const content = "hello world\n"
      const filePath = join(tmp, "sample.txt")
      writeFileSync(filePath, content, "utf-8")

      const fileHash = fileSha256(filePath)
      const expected = sha256(content)
      expect(fileHash).toBe(expected)
      expect(fileHash.length).toBe(64) // 256 bits = 64 hex chars
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("sha256 is deterministic", () => {
    const content = "consistent data\n"
    expect(sha256(content)).toBe(sha256(content))
  })

  it("sha256 produces 64-character hex string", () => {
    const hash = sha256("test data")
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
