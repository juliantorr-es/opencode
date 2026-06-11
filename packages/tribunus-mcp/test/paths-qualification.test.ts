import { describe, it, expect, beforeAll } from "bun:test"
import { resolve, sep } from "node:path"
import { initPathPolicy, validatePath } from "../src/governance/paths"

describe("path root specificity ordering", () => {
  const worktree = "/Users/test/Tribunus"

  beforeAll(() => {
    initPathPolicy(
      worktree,
      resolve(worktree, "packages/compute-native/evidence"),
      resolve(worktree, "../models"),
      resolve(worktree, ".omp/evidence"),
    )
  })

  it("writable path inside packages/compute-native resolves writable", () => {
    const p = resolve(worktree, "packages/compute-native/code-review/output.zip")
    const result = validatePath(p, true)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it("read-only sibling path (packages/console) resolves read-only when writable required", () => {
    const p = resolve(worktree, "packages/console/src/index.ts")
    const result = validatePath(p, true)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("not in a writable root")
  })

  it("read-only sibling resolves valid when writable not required", () => {
    const p = resolve(worktree, "packages/console/src/index.ts")
    const result = validatePath(p, false)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it("worktree root itself resolves read-only", () => {
    const result = validatePath(worktree, true)
    expect(result.valid).toBe(false)
    expect(result.error).toContain("not in a writable root")
  })

  it("prefix trap: packages/compute-native-old does not match compute-native root", () => {
    const trap = resolve(worktree, "packages/compute-native-old/foo.bar")
    const result = validatePath(trap, false)
    // Should not match the compute-native root because of boundary-safe sep check
    // Should fall through to the worktree root: valid (read-only)
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it("prefix trap: writable required on compute-native-old fails correctly", () => {
    const trap = resolve(worktree, "packages/compute-native-old/foo.bar")
    const result = validatePath(trap, true)
    // Matches worktree root (read-only) → not in a writable root
    expect(result.valid).toBe(false)
    expect(result.error).toContain("not in a writable root")
  })
})
