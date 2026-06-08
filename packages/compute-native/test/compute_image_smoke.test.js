import { describe, expect, test } from "bun:test"
import { createRequire } from "module"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const compute = require("../index.js")

describe("compute-image addon smoke", () => {
  test("loads through index.js and exposes ComputeImage calls", () => {
    expect(typeof compute.compileImage).toBe("function")
    expect(typeof compute.readCompiledImage).toBe("function")
    expect(typeof compute.verifyCompiledImage).toBe("function")

    const sourceDir = mkdtempSync(join(tmpdir(), "tribunus-compute-native-source-"))
    const outputDir = mkdtempSync(join(tmpdir(), "tribunus-compute-native-output-"))
    const readerDir = mkdtempSync(join(tmpdir(), "tribunus-compute-native-reader-"))

    expect(() => compute.compileImage(sourceDir, outputDir)).toThrow()
    expect(() => compute.readCompiledImage(readerDir)).toThrow()
    expect(() => compute.verifyCompiledImage(readerDir)).toThrow()
  })
})
