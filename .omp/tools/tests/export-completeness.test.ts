import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { z } from "zod"

import factory from "../code_review_export"
import { analyzeSourceGraphFile } from "../_lib/review-export/source-graph.js"
import { exportPairedPackets } from "../_lib/code-intelligence/snapshot"
import type { ReviewExportProgressEventV1 } from "../_lib/review-export/progress.js"

// ─── Helpers ──────────────────────────────────────────────────────────

function hasBinary(name: string): boolean {
  const r = spawnSync("which", [name], { encoding: "utf8" })
  return r.status === 0
}

function mkdirp(p: string) {
  mkdirSync(p, { recursive: true })
}

const REQUIRED_PATHS = [
  ".omp/tools/struct_read.ts",
  ".omp/tools/text_replace.ts",
  ".omp/tools/batch_edit.ts",
  ".omp/tools/code_review_export.ts",
  ".omp/tools/review_packet_export.ts",
  ".omp/tools/semantic_review_packet_export.ts",
  ".omp/tools/verify_review_packets.ts",
  ".omp/tools/_lib/types.ts",
  ".omp/tools/_lib/envelope.ts",
  ".omp/tools/_lib/path-policy.ts",
  ".omp/tools/_lib/hashing.ts",
  ".omp/tools/_lib/receipts.ts",
  ".omp/tools/_lib/diff.ts",
  ".omp/tools/_lib/manifest.ts",
  ".omp/tools/_lib/schemas.ts",
  ".omp/tools/_lib/errors.ts",
  ".omp/tools/_lib/ids.ts",
  ".omp/tools/_lib/json.ts",
  ".omp/tools/_lib/audit.ts",
  ".omp/tools/_lib/tool-context.ts",
  ".omp/tools/_lib/write-journal.ts",
  ".omp/tools/_lib/text-file.ts",
  ".omp/tools/_lib/redaction.ts",
  ".omp/tools/_lib/review-export/source-graph.ts",
  ".omp/tools/_lib/review-export/verify-packets.ts",
  ".omp/tools/manifests/struct_read.v1.json",
  ".omp/tools/manifests/text_replace.v1.json",
  ".omp/tools/manifests/batch_edit.v1.json",
  ".omp/tools/manifests/code_review_export.v1.json",
  ".omp/tools/manifests/review_packet_export.v1.json",
  ".omp/tools/manifests/semantic_review_packet_export.v1.json",
  ".omp/tools/manifests/verify_review_packets.v1.json",
  ".omp/agents/exporter.md",
  ".omp/tools/tests/path-policy.test.ts",
  ".omp/tools/tests/receipts.test.ts",
  ".omp/tools/tests/text_replace.test.ts",
  ".omp/tools/tests/batch_edit.test.ts",
  ".omp/tools/tests/struct_read.test.ts",
  ".omp/tools/tests/manifest.test.ts",
  ".omp/tools/tests/export-completeness.test.ts",
  ".omp/mcp.json",
  ".omp/mcp-manifest.v1.json",
  "package.json",
  "AGENTS.md",
]

function catalogZip(zipPath: string, dest: string): string[] {
  mkdirp(dest)
  const r = spawnSync("unzip", ["-o", zipPath, "-d", dest], {
    encoding: "utf8",
    timeout: 30000,
  })
  if (r.status !== 0) {
    throw new Error(`unzip failed: ${r.stderr || r.stdout}`)
  }
  return listFilesRecursive(dest)
}

function readZipEntryBytes(zipPath: string, entry: string): Buffer {
  const result = spawnSync("unzip", ["-p", zipPath, entry], {
    timeout: 30000,
    maxBuffer: 100 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`unzip -p failed for ${entry}: ${result.stderr?.toString() || result.stdout?.toString() || "unknown error"}`)
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? [])
}

function listFilesRecursive(dir: string): string[] {
  const result: string[] = []
  const walk = (d: string, prefix: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(resolve(d, entry.name), rel)
      } else {
        result.push(rel)
      }
    }
  }
  if (existsSync(dir)) walk(dir, "")
  return result.sort()
}

function createMinimalRepo(root: string) {
  for (const rp of REQUIRED_PATHS) {
    const fullPath = resolve(root, rp)
    mkdirp(resolve(fullPath, ".."))
    const content = rp.endsWith(".json")
      ? JSON.stringify({ schema: "test", name: rp.split("/").pop(), version: "1" }, null, 2)
      : `// ${rp} — test stub`
    writeFileSync(fullPath, content, "utf8")
  }

  mkdirp(resolve(root, "src"))
  writeFileSync(resolve(root, "src/a.ts"), [
    "import { b } from './b'",
    "import type { BType } from './b'",
    "import './side'",
    "import external from 'external-package'",
    "export const a = b + 1",
    "export type { BType } from './b'",
    "void external",
  ].join("\n"), "utf8")
  writeFileSync(resolve(root, "src/b.ts"), "export const b = 1\nexport type BType = number\n", "utf8")
  writeFileSync(resolve(root, "src/side.ts"), "export const side = true\n", "utf8")

  spawnSync("git", ["init"], { cwd: root, encoding: "utf8" })
  spawnSync("git", ["config", "user.email", "test@test"], { cwd: root, encoding: "utf8" })
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root, encoding: "utf8" })
  spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" })
  const commit = spawnSync("git", ["commit", "-m", "initial"], { cwd: root, encoding: "utf8" })
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr}`)
  }
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("code_review_export completeness", () => {
  const hasZipBin = hasBinary("zip")
  const hasUnzipBin = hasBinary("unzip")
  const canRun = hasZipBin && hasUnzipBin

  let tmpDir: string
  let zipPath: string
  let unzipDest: string
  let exportError: string | undefined
  let manifest: Record<string, unknown> | undefined
  let result: unknown

  beforeAll(async () => {
    if (!canRun) return

    tmpDir = resolve(tmpdir(), `export-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirp(tmpDir)
    createMinimalRepo(tmpDir)

    const pi = { cwd: tmpDir, zod: z }
    const ctx = { sessionId: "test-session" }

    try {
      const tool = factory(pi)
      result = await tool.execute(
        "test-call-1",
        { include_untracked: false },
        () => {},
        ctx,
        undefined,
      )
    } catch (e: unknown) {
      exportError = e instanceof Error ? e.message : String(e)
      return
    }

    zipPath = resolve(tmpDir, "code_review.zip")
    if (!existsSync(zipPath)) {
      exportError = "code_review.zip not created"
      return
    }

    unzipDest = resolve(tmpDir, "extracted")
    try {
      catalogZip(zipPath, unzipDest)
    } catch (e: unknown) {
      exportError = `unzip failed: ${e instanceof Error ? e.message : String(e)}`
      return
    }

    const manifestPath = resolve(unzipDest, "code_review", "REVIEW_PACKET_MANIFEST.json")
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
    }
  })

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // ── Tool availability ──

  it("zip binary is available", () => {
    expect(hasZipBin).toBe(true)
  })

  it("unzip binary is available", () => {
    expect(hasUnzipBin).toBe(true)
  })

  // ── Export runs without error ──

  it("export executes without error", () => {
    if (!canRun) return
    expect(exportError).toBeUndefined()
  })

  it("creates code_review.zip", () => {
    if (!canRun) return
    expect(exportError).toBeUndefined()
    expect(existsSync(zipPath)).toBe(true)
  })

  // ── Metadata files ──

  it("writes REVIEW_PACKET_MANIFEST.json", () => {
    if (!canRun || exportError) return
    const p = resolve(unzipDest, "code_review", "REVIEW_PACKET_MANIFEST.json")
    expect(existsSync(p)).toBe(true)
    expect(manifest).toBeDefined()
    expect(manifest?.schema).toBe("omp.code_review_packet_manifest.v1")
  })

  it("writes REVIEW_PACKET_TREE.txt", () => {
    if (!canRun || exportError) return
    const p = resolve(unzipDest, "code_review", "REVIEW_PACKET_TREE.txt")
    expect(existsSync(p)).toBe(true)
    const content = readFileSync(p, "utf8")
    expect(content).toContain("code_review/")
  })

  it("rejects the Gemini code-folder profile when required OMP paths are missing", async () => {
    if (!canRun) return

    const gemDir = resolve(tmpdir(), `export-gem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    try {
      mkdirp(gemDir)
      createMinimalRepo(gemDir)

      const piGem = { cwd: gemDir, zod: z }
      const ctxGem = { sessionId: "gem-test" }
      const toolGem = factory(piGem)
      await expect(
        toolGem.execute(
          "gem-call",
          { include_untracked: false, profile: "gemini_code_review" },
          () => {},
          ctxGem,
          undefined,
        ),
      ).rejects.toThrow(/Gemini code-folder export requires all expected OMP paths/)
    } finally {
      rmSync(gemDir, { recursive: true, force: true })
    }
  })

  it("supports the Gemini attachment profile with 10 bundled files", async () => {
    if (!canRun) return

    const attDir = resolve(tmpdir(), `export-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const attZipDest = resolve(attDir, "att-extract")
    try {
      mkdirp(attDir)
      createMinimalRepo(attDir)

      const piAtt = { cwd: attDir, zod: z }
      const ctxAtt = { sessionId: "att-test" }
      const toolAtt = factory(piAtt)
      await toolAtt.execute(
        "att-call",
        { include_untracked: false, profile: "gemini_zip_attachment" },
        () => {},
        ctxAtt,
        undefined,
      )

      const attZip = resolve(attDir, "tribunus-gemini-review.zip")
      expect(existsSync(attZip)).toBe(true)

      catalogZip(attZip, attZipDest)
      const files = listFilesRecursive(attZipDest)
      expect(files.length).toBe(10)
      expect(files.some((f) => f.endsWith("01_REVIEW_GUIDE.md"))).toBe(true)
      expect(files.some((f) => f.endsWith("10_GIT_DIFF.patch"))).toBe(true)
    } finally {
      rmSync(attDir, { recursive: true, force: true })
    }
  })

  it("supports the Gemini IR profile with 10 JSON artifacts", async () => {
    if (!canRun) return

    const irDir = resolve(tmpdir(), `export-ir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const irZipDest = resolve(irDir, "ir-extract")
    try {
      mkdirp(irDir)
      createMinimalRepo(irDir)

      const piIr = { cwd: irDir, zod: z }
      const ctxIr = { sessionId: "ir-test" }
      const toolIr = factory(piIr)
      await toolIr.execute(
        "ir-call",
        { include_untracked: false, profile: "gemini_structured_ir_v1" },
        () => {},
        ctxIr,
        undefined,
      )

      const irZip = resolve(irDir, "tribunus-gemini-ir.zip")
      expect(existsSync(irZip)).toBe(true)

      catalogZip(irZip, irZipDest)
      const files = listFilesRecursive(irZipDest)
      expect(files.length).toBe(10)
      expect(files.some((f) => f.endsWith("01_manifest.json"))).toBe(true)
      expect(files.some((f) => f.endsWith("10_review_findings.json"))).toBe(true)
      const moduleGraph = JSON.parse(readFileSync(resolve(irZipDest, "tribunus-gemini-ir", "03_module_graph.json"), "utf8")) as Record<string, unknown>
      const sourceGraph = moduleGraph.source_graph as Record<string, unknown>
      expect(sourceGraph.files as number).toBeGreaterThan(0)
      expect(sourceGraph.oxc_files as number).toBeGreaterThan(0)
      expect(sourceGraph.resolved_edges as number).toBeGreaterThan(0)
    } finally {
      rmSync(irDir, { recursive: true, force: true })
    }
  })

  it("parses and resolves local edges through the Oxc source graph adapter", () => {
    const graphDir = resolve(tmpdir(), `source-graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    try {
      mkdirp(resolve(graphDir, "src"))
      writeFileSync(resolve(graphDir, "src/a.ts"), [
        "import { b } from './b'",
        "import type { BType } from './b'",
        "import './side'",
        "import external from 'external-package'",
        "export const a = b + 1",
        "export type { BType } from './b'",
        "void external",
      ].join("\n"), "utf8")
      writeFileSync(resolve(graphDir, "src/b.ts"), "export const b = 1\nexport type BType = number\n", "utf8")
      writeFileSync(resolve(graphDir, "src/side.ts"), "export const side = true\n", "utf8")

      const analysis = analyzeSourceGraphFile({
        path: "src/a.ts",
        text: readFileSync(resolve(graphDir, "src/a.ts"), "utf8"),
        repoRoot: graphDir,
        includedSet: new Set(["src/a.ts", "src/b.ts", "src/side.ts"]),
      })

      expect(analysis.parser).toBe("oxc")
      expect(analysis.parse_errors).toBe(0)
      expect(analysis.metrics.static_imports).toBeGreaterThanOrEqual(4)
      expect(analysis.metrics.static_exports).toBeGreaterThanOrEqual(2)
      expect(analysis.metrics.resolved_edges).toBeGreaterThanOrEqual(3)
      expect(analysis.imports.some((entry) => entry.specifier === "./b" && entry.resolved_path === "src/b.ts")).toBe(true)
      expect(analysis.imports.some((entry) => entry.specifier === "./b" && entry.import_kind === "type_only")).toBe(true)
      expect(analysis.imports.some((entry) => entry.specifier === "./side" && entry.import_kind === "side_effect")).toBe(true)
      expect(analysis.imports.some((entry) => entry.specifier === "external-package" && entry.resolution_status === "external_package")).toBe(true)
    } finally {
      rmSync(graphDir, { recursive: true, force: true })
    }
  })

  it("embeds the semantic artifacts byte-for-byte inside the source packet", async () => {
    if (!canRun) return

    const repoRoot = resolve(import.meta.dir, "../../..")
    const progressEvents: ReviewExportProgressEventV1[] = []
    const paired = await exportPairedPackets(repoRoot, {
      progress: (event) => {
        progressEvents.push(event)
      },
    })
    const entries = [
      "01_manifest.json",
      "02_file_index.json",
      "03_module_graph.json",
      "04_symbol_index.json",
      "05_type_api_surface.json",
      "06_tool_kernel_ir.json",
      "07_pglite_duckdb_ir.json",
      "08_tests_and_ci_ir.json",
      "09_architecture_context.json",
      "10_review_findings.json",
    ]

    for (const entry of entries) {
      const semanticBytes = readZipEntryBytes(paired.semanticZipPath, `tribunus-gemini-ir/${entry}`)
      const sourceBytes = readZipEntryBytes(paired.sourceZipPath, `tribunus-source-review/semantic-review/${entry}`)
      expect(Buffer.compare(semanticBytes, sourceBytes)).toBe(0)
    }
    expect(readZipEntryBytes(paired.sourceZipPath, "tribunus-source-review/.omp/tools/_lib/review-export/source-graph.ts").length).toBeGreaterThan(0)

    expect(paired.timings_ms?.discover).toBeDefined()
    expect(paired.timings_ms?.index).toBeDefined()
    expect(paired.timings_ms?.semantic_zip).toBeDefined()
    expect(paired.timings_ms?.source_zip).toBeDefined()
    expect(paired.timings_ms?.verify).toBeDefined()
    expect(progressEvents.some((event) => event.stage === "discover" && event.status === "done")).toBe(true)
    expect(progressEvents.some((event) => event.stage === "semantic_zip" && event.status === "done")).toBe(true)
    expect(progressEvents.some((event) => event.stage === "source_zip" && event.status === "done")).toBe(true)
  }, 600000)

  it("writes REVIEW_PACKET_WARNINGS.md", () => {
    if (!canRun || exportError) return
    const p = resolve(unzipDest, "code_review", "REVIEW_PACKET_WARNINGS.md")
    expect(existsSync(p)).toBe(true)
  })

  it("writes included-files.txt", () => {
    if (!canRun || exportError) return
    const p = resolve(unzipDest, "code_review", "metadata", "included-files.txt")
    expect(existsSync(p)).toBe(true)
    const content = readFileSync(p, "utf8")
    expect(content).toContain(".omp/tools/_lib/types.ts")
  })

  it("writes excluded-files.txt", () => {
    if (!canRun || exportError) return
    const p = resolve(unzipDest, "code_review", "metadata", "excluded-files.txt")
    expect(existsSync(p)).toBe(true)
  })

  it("writes oversized-files.txt", () => {
    if (!canRun || exportError) return
    const p = resolve(unzipDest, "code_review", "metadata", "oversized-files.txt")
    expect(existsSync(p)).toBe(true)
    const content = readFileSync(p, "utf8")
    expect(content).toContain("(none)")
  })

  it("writes unresolved-imports.txt", () => {
    if (!canRun || exportError) return
    const p = resolve(unzipDest, "code_review", "metadata", "unresolved-imports.txt")
    expect(existsSync(p)).toBe(true)
  })

  // ── File inclusion ──

  it("includes .omp/tools/_lib files", () => {
    if (!canRun || exportError) return
    const repoDir = resolve(unzipDest, "code_review", "repo")
    expect(existsSync(resolve(repoDir, ".omp/tools/_lib/types.ts"))).toBe(true)
    expect(existsSync(resolve(repoDir, ".omp/tools/_lib/envelope.ts"))).toBe(true)
    expect(existsSync(resolve(repoDir, ".omp/tools/_lib/path-policy.ts"))).toBe(true)
  })

  it("includes .omp/tools/manifests", () => {
    if (!canRun || exportError) return
    const repoDir = resolve(unzipDest, "code_review", "repo")
    const subdir = resolve(repoDir, ".omp/tools/manifests")
    expect(existsSync(subdir)).toBe(true)
    expect(existsSync(resolve(repoDir, ".omp/tools/manifests/struct_read.v1.json"))).toBe(true)
    expect(existsSync(resolve(repoDir, ".omp/tools/manifests/text_replace.v1.json"))).toBe(true)
    expect(existsSync(resolve(repoDir, ".omp/tools/manifests/batch_edit.v1.json"))).toBe(true)
  })

  it("includes .omp/tools/tests", () => {
    if (!canRun || exportError) return
    const repoDir = resolve(unzipDest, "code_review", "repo")
    expect(existsSync(resolve(repoDir, ".omp/tools/tests/manifest.test.ts"))).toBe(true)
    expect(existsSync(resolve(repoDir, ".omp/tools/tests/export-completeness.test.ts"))).toBe(true)
  })

  it("includes the export tool implementation itself", () => {
    if (!canRun || exportError) return
    const repoDir = resolve(unzipDest, "code_review", "repo")
    expect(existsSync(resolve(repoDir, ".omp/tools/code_review_export.ts"))).toBe(true)
  })

  it("registers export tools for exporter agents", () => {
    const repoRoot = resolve(import.meta.dir, "../../..")
    const exporterAgent = readFileSync(resolve(repoRoot, ".omp/agents/exporter.md"), "utf8")
    expect(exporterAgent).toContain("tools: read, search, find, bash, code_review_export, review_packet_export, semantic_review_packet_export")

    for (const toolId of ["code_review_export", "review_packet_export", "semantic_review_packet_export"]) {
      const manifest = JSON.parse(readFileSync(resolve(repoRoot, `.omp/tools/manifests/${toolId}.v1.json`), "utf8")) as Record<string, unknown>
      expect(manifest.tool_id).toBe(toolId)
      const providerExports = manifest.provider_exports as Record<string, unknown>
      expect(providerExports.openai_tools).toBe(true)
      expect(providerExports.anthropic_tools).toBe(true)
      expect(providerExports.mistral_function_calling).toBe(true)
      expect(providerExports.mcp).toBe(true)
    }
  })

  it("includes root package.json", () => {
    if (!canRun || exportError) return
    const repoDir = resolve(unzipDest, "code_review", "repo")
    expect(existsSync(resolve(repoDir, "package.json"))).toBe(true)
  })

  it("includes AGENTS.md", () => {
    if (!canRun || exportError) return
    const repoDir = resolve(unzipDest, "code_review", "repo")
    expect(existsSync(resolve(repoDir, "AGENTS.md"))).toBe(true)
  })

  // ── Exclusion checks ──

  it("excludes node_modules", () => {
    if (!canRun || exportError) return
    const repoDir = resolve(unzipDest, "code_review", "repo")
    expect(existsSync(resolve(repoDir, "node_modules"))).toBe(false)
  })

  it("excludes .omp/state", () => {
    if (!canRun || exportError) return
    const repoDir = resolve(unzipDest, "code_review", "repo")
    expect(existsSync(resolve(repoDir, ".omp/state"))).toBe(false)
  })

  it("excludes .omp/evidence", () => {
    if (!canRun || exportError) return
    const repoDir = resolve(unzipDest, "code_review", "repo")
    expect(existsSync(resolve(repoDir, ".omp/evidence"))).toBe(false)
  })

  // ── Manifest structure ──

  it("manifest has required_paths array", () => {
    if (!canRun || exportError || !manifest) return
    const requiredPaths = manifest.required_paths as Array<Record<string, unknown>>
    expect(Array.isArray(requiredPaths)).toBe(true)
    const typesEntry = requiredPaths.find((r) => r.path === ".omp/tools/_lib/types.ts")
    expect(typesEntry).toBeDefined()
    expect(typesEntry?.status).toBe("included")
  })

  it("manifest has counts object", () => {
    if (!canRun || exportError || !manifest) return
    const counts = manifest.counts as Record<string, unknown>
    expect(counts).toBeDefined()
    expect(typeof counts.included_files).toBe("number")
    expect(typeof counts.excluded_files).toBe("number")
  })

  it("manifest has files array with sha256 entries", () => {
    if (!canRun || exportError || !manifest) return
    const files = manifest.files as Array<Record<string, unknown>>
    expect(Array.isArray(files)).toBe(true)
    expect(files.length).toBeGreaterThan(0)
    const libTypes = files.find((f) => f.path === ".omp/tools/_lib/types.ts")
    expect(libTypes).toBeDefined()
    expect(typeof libTypes?.sha256).toBe("string")
    const sha = libTypes?.sha256 as string
    expect(sha.length).toBe(64)
    expect(/^[0-9a-f]{64}$/.test(sha)).toBe(true)
    expect(typeof libTypes?.size_bytes).toBe("number")
    expect(libTypes?.category).toBe("source")
  })

  // ── Oversized files ──

  it("records oversized files", async () => {
    if (!canRun) return

    const overDir = resolve(tmpdir(), `export-over-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const overZipDir = resolve(overDir, "overseen")
    try {
      mkdirp(overDir)
      writeFileSync(resolve(overDir, "package.json"), JSON.stringify({ name: "over-test" }), "utf8")
      writeFileSync(resolve(overDir, "AGENTS.md"), "# Over test\n", "utf8")

      const tDir = resolve(overDir, ".omp/tools")
      mkdirp(resolve(tDir, "_lib"))
      const libFiles = [
        "types", "envelope", "path-policy", "hashing", "receipts", "diff",
        "manifest", "schemas", "errors", "ids", "json", "audit",
        "tool-context", "write-journal", "text-file", "redaction",
      ]
      for (const f of libFiles) writeFileSync(resolve(tDir, `_lib/${f}.ts`), `// ${f}`, "utf8")
      for (const f of ["struct_read", "text_replace", "batch_edit", "code_review_export"]) {
        writeFileSync(resolve(tDir, `${f}.ts`), `// ${f}`, "utf8")
      }
      mkdirp(resolve(tDir, "manifests"))
      for (const f of ["struct_read", "text_replace", "batch_edit"]) {
        writeFileSync(resolve(tDir, `manifests/${f}.v1.json`), "{}", "utf8")
      }
      mkdirp(resolve(tDir, "tests"))
      const testFiles = [
        "path-policy.test.ts", "receipts.test.ts", "text_replace.test.ts",
        "batch_edit.test.ts", "struct_read.test.ts", "manifest.test.ts",
        "export-completeness.test.ts",
      ]
      for (const t of testFiles) writeFileSync(resolve(tDir, "tests", t), "// test", "utf8")
      writeFileSync(resolve(overDir, ".omp/mcp.json"), "{}", "utf8")
      writeFileSync(resolve(overDir, ".omp/mcp-manifest.v1.json"), "{}", "utf8")

      // Create oversized .ts file (>2MB)
      const buf = Buffer.alloc(3 * 1024 * 1024, "x")
      writeFileSync(resolve(overDir, "big-file.ts"), buf)

      spawnSync("git", ["init"], { cwd: overDir, encoding: "utf8" })
      spawnSync("git", ["config", "user.email", "t@t"], { cwd: overDir, encoding: "utf8" })
      spawnSync("git", ["config", "user.name", "T"], { cwd: overDir, encoding: "utf8" })
      spawnSync("git", ["add", "."], { cwd: overDir, encoding: "utf8" })
      const cr = spawnSync("git", ["commit", "-m", "init"], { cwd: overDir, encoding: "utf8" })
      if (cr.status !== 0) throw new Error(`commit: ${cr.stderr}`)

      const pi2 = { cwd: overDir, zod: z }
      const ctx2 = { sessionId: "over-test" }
      const tool2 = factory(pi2)
      await tool2.execute("over-call", { include_untracked: false }, () => {}, ctx2, undefined)

      const overZip = resolve(overDir, "code_review.zip")
      expect(existsSync(overZip)).toBe(true)

      catalogZip(overZip, overZipDir)

      const overFPath = resolve(overZipDir, "code_review", "metadata", "oversized-files.txt")
      expect(existsSync(overFPath)).toBe(true)
      const overContent = readFileSync(overFPath, "utf8")
      expect(overContent).toContain("big-file.ts")

      // oversized file should NOT be in the repo copy
      expect(existsSync(resolve(overZipDir, "code_review", "repo", "big-file.ts"))).toBe(false)

      const overManifest = JSON.parse(
        readFileSync(resolve(overZipDir, "code_review", "REVIEW_PACKET_MANIFEST.json"), "utf8"),
      ) as Record<string, unknown>
      const overCounts = overManifest.counts as Record<string, unknown>
      expect(typeof overCounts.oversized_files).toBe("number")
      expect(overCounts.oversized_files as number).toBeGreaterThan(0)
    } finally {
      rmSync(overDir, { recursive: true, force: true })
    }
  })

  // ── Missing required paths ──

  it("flags missing required paths", async () => {
    if (!canRun) return

    const missDir = resolve(tmpdir(), `export-miss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const missZipDir = resolve(missDir, "miss-extract")
    try {
      mkdirp(missDir)
      writeFileSync(resolve(missDir, "package.json"), JSON.stringify({ name: "miss-test" }), "utf8")
      writeFileSync(resolve(missDir, "AGENTS.md"), "# Miss\n", "utf8")

      const tDir = resolve(missDir, ".omp/tools")
      mkdirp(resolve(tDir, "_lib"))
      const libFiles = [
        "types", "envelope", "path-policy", "hashing", "receipts", "diff",
        "manifest", "schemas", "errors", "ids", "json", "audit",
        "tool-context", "write-journal", "text-file", "redaction",
      ]
      for (const f of libFiles) writeFileSync(resolve(tDir, `_lib/${f}.ts`), `// ${f}`, "utf8")
      for (const f of ["struct_read", "text_replace", "batch_edit", "code_review_export"]) {
        writeFileSync(resolve(tDir, `${f}.ts`), `// ${f}`, "utf8")
      }

      // Only one of the three manifests present — two are intentionally missing
      mkdirp(resolve(tDir, "manifests"))
      writeFileSync(resolve(tDir, "manifests/struct_read.v1.json"), "{}", "utf8")

      // All test files present
      mkdirp(resolve(tDir, "tests"))
      const testFiles = [
        "path-policy.test.ts", "receipts.test.ts", "text_replace.test.ts",
        "batch_edit.test.ts", "struct_read.test.ts", "manifest.test.ts",
        "export-completeness.test.ts",
      ]
      for (const t of testFiles) writeFileSync(resolve(tDir, "tests", t), "// test", "utf8")

      writeFileSync(resolve(missDir, ".omp/mcp.json"), "{}", "utf8")
      writeFileSync(resolve(missDir, ".omp/mcp-manifest.v1.json"), "{}", "utf8")

      spawnSync("git", ["init"], { cwd: missDir, encoding: "utf8" })
      spawnSync("git", ["config", "user.email", "t@t"], { cwd: missDir, encoding: "utf8" })
      spawnSync("git", ["config", "user.name", "T"], { cwd: missDir, encoding: "utf8" })
      spawnSync("git", ["add", "."], { cwd: missDir, encoding: "utf8" })
      const mr = spawnSync("git", ["commit", "-m", "init"], { cwd: missDir, encoding: "utf8" })
      if (mr.status !== 0) throw new Error(`commit: ${mr.stderr}`)

      const pi3 = { cwd: missDir, zod: z }
      const ctx3 = { sessionId: "miss-test" }
      const tool3 = factory(pi3)
      await tool3.execute("miss-call", { include_untracked: false }, () => {}, ctx3, undefined)

      const missZip = resolve(missDir, "code_review.zip")
      expect(existsSync(missZip)).toBe(true)

      catalogZip(missZip, missZipDir)

      const warnMd = readFileSync(
        resolve(missZipDir, "code_review", "REVIEW_PACKET_WARNINGS.md"),
        "utf8",
      )
      expect(warnMd).toContain("missing")

      const missingPath = resolve(missZipDir, "code_review", "metadata", "missing-expected-files.txt")
      expect(existsSync(missingPath)).toBe(true)
      const missingContent = readFileSync(missingPath, "utf8")
      expect(missingContent).toContain("text_replace.v1.json")
      expect(missingContent).toContain("batch_edit.v1.json")

      const missManifest = JSON.parse(
        readFileSync(resolve(missZipDir, "code_review", "REVIEW_PACKET_MANIFEST.json"), "utf8"),
      ) as Record<string, unknown>
      const missCounts = missManifest.counts as Record<string, unknown>
      expect(typeof missCounts.missing_expected_files).toBe("number")
      expect(missCounts.missing_expected_files as number).toBeGreaterThan(0)
    } finally {
      rmSync(missDir, { recursive: true, force: true })
    }
  })

  // ── Optional directories absent ──

  it("does not crash when optional directories are absent", async () => {
    if (!canRun) return

    const leanDir = resolve(tmpdir(), `export-lean-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    try {
      mkdirp(leanDir)
      writeFileSync(resolve(leanDir, "package.json"), JSON.stringify({ name: "lean" }), "utf8")
      writeFileSync(resolve(leanDir, "AGENTS.md"), "# Lean\n", "utf8")

      const tDir = resolve(leanDir, ".omp/tools")
      mkdirp(resolve(tDir, "_lib"))
      const libFiles = [
        "types", "envelope", "path-policy", "hashing", "receipts", "diff",
        "manifest", "schemas", "errors", "ids", "json", "audit",
        "tool-context", "write-journal", "text-file", "redaction",
      ]
      for (const f of libFiles) writeFileSync(resolve(tDir, `_lib/${f}.ts`), `// ${f}`, "utf8")
      for (const f of ["struct_read", "text_replace", "batch_edit", "code_review_export"]) {
        writeFileSync(resolve(tDir, `${f}.ts`), `// ${f}`, "utf8")
      }
      mkdirp(resolve(tDir, "manifests"))
      for (const f of ["struct_read", "text_replace", "batch_edit"]) {
        writeFileSync(resolve(tDir, `manifests/${f}.v1.json`), "{}", "utf8")
      }
      mkdirp(resolve(tDir, "tests"))
      const testFiles = [
        "path-policy.test.ts", "receipts.test.ts", "text_replace.test.ts",
        "batch_edit.test.ts", "struct_read.test.ts", "manifest.test.ts",
        "export-completeness.test.ts",
      ]
      for (const t of testFiles) writeFileSync(resolve(tDir, "tests", t), "// test", "utf8")
      writeFileSync(resolve(leanDir, ".omp/mcp.json"), "{}", "utf8")
      writeFileSync(resolve(leanDir, ".omp/mcp-manifest.v1.json"), "{}", "utf8")

      // No docs/ directory, no .omp/state/, no .omp/evidence/, no node_modules

      spawnSync("git", ["init"], { cwd: leanDir, encoding: "utf8" })
      spawnSync("git", ["config", "user.email", "t@t"], { cwd: leanDir, encoding: "utf8" })
      spawnSync("git", ["config", "user.name", "T"], { cwd: leanDir, encoding: "utf8" })
      spawnSync("git", ["add", "."], { cwd: leanDir, encoding: "utf8" })
      const lr = spawnSync("git", ["commit", "-m", "init"], { cwd: leanDir, encoding: "utf8" })
      if (lr.status !== 0) throw new Error(`commit: ${lr.stderr}`)

      const pi4 = { cwd: leanDir, zod: z }
      const ctx4 = { sessionId: "lean-test" }
      const tool4 = factory(pi4)
      const res = await tool4.execute(
        "lean-call",
        { include_untracked: false },
        () => {},
        ctx4,
        undefined,
      )

      const leanZip = resolve(leanDir, "code_review.zip")
      expect(existsSync(leanZip)).toBe(true)

      const resultObj = res as Record<string, unknown>
      expect(resultObj.details).toBeDefined()
      const details = resultObj.details as Record<string, unknown>
      expect(details.status).toBe("ok")
    } finally {
      rmSync(leanDir, { recursive: true, force: true })
    }
  })
})
