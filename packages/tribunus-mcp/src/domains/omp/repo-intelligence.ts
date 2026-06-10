import { registerTool } from "../../server/registry.js"
import type { InvocationContext } from "../../governance/invocation-context.js"
import type { Capability } from "../../governance/capabilities.js"
import type { RegisteredTool } from "../../server/registry.js"
import { readdir, readFile } from "node:fs/promises"
import { join, resolve, relative, dirname } from "node:path"
import type { Dirent } from "node:fs"
import { fileURLToPath } from "node:url"
import { validatePath } from "../../governance/paths.js"

// Oxc services
import { semanticRepoMap } from "../../services/code-intelligence/queries/semantic-repo-map.js"
import { symbolLookup } from "../../services/code-intelligence/queries/symbol-lookup.js"
import { impactAnalysis } from "../../services/code-intelligence/queries/impact-analysis.js"
import { authorityAudit } from "../../services/code-intelligence/queries/authority-audit.js"
import { testGapReport } from "../../services/code-intelligence/queries/test-gap-report.js"
import { buildCodeReviewExport } from "../../services/review-export/bootstrap-builder.js"
import { reviewPacketExport } from "../../services/code-intelligence/exports/review-packet-export.js"
import { semanticReviewPacketExport } from "../../services/code-intelligence/exports/semantic-review-packet-export.js"
import { verifyReviewPackets } from "../../services/review-export/verify-packets.js"

function ok(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] } }
function err(msg: string) { return { content: [{ type: "text" as const, text: msg }], isError: true } }

type ToolInputProps = Record<string, { type?: string; enum?: string[]; items?: { type: string }; description?: string }>
type ToolProps = Record<string, unknown>

function register(name: string, desc: string, props: ToolInputProps, req: string[], caps: Capability[], ms: number, fn: (ctx: InvocationContext, a: ToolProps) => Promise<unknown>, aliases?: string[]): void {
  registerTool({
    name,
    description: desc,
    inputSchema: { type: "object", properties: props, required: req },
    requiredCapabilities: caps,
    timeoutMs: ms,
    execute: fn,
    aliases,
  } satisfies Omit<RegisteredTool, "aliases"> & { aliases?: string[] })
}

export function registerOmpRepoIntelTools(): void {
  register("tribunus_search", "Search for patterns in files. Pure TypeScript. Respects .gitignore.", {
    pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, max_results: { type: "number" },
  }, ["pattern"], ["repository:read"], 30_000, async (_ctx, a) => {
    const pattern = a.pattern as string
    let rawPath = (a.path as string) || process.cwd()
    const pathCheck = validatePath(rawPath, false)
    if (!pathCheck.valid) return err(pathCheck.error || "path rejected")
    const searchPath = pathCheck.resolved
    const maxResults = (a.max_results as number) || 30
    const results: Array<{ file: string; line: number; text: string }> = []
    async function walk(dir: string) {
      if (results.length >= maxResults) return
      let entries: Dirent[] = []
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue
        if (e.name === "node_modules" || e.name === ".git") continue
        const full = join(dir, e.name)
        if (e.isDirectory()) { await walk(full) }
        else {
          if (results.length >= maxResults) return
          try {
            const content = await readFile(full, "utf-8")
            const lines = content.split("\n")
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(pattern)) {
                results.push({ file: relative(searchPath, full), line: i + 1, text: lines[i].trim() })
                if (results.length >= maxResults) return
              }
            }
          } catch {}
        }
      }
    }
    await walk(resolve(searchPath))
    return ok({ pattern, results, count: results.length })
  })

  register("tribunus_find", "Find files and directories. Respects .gitignore.", {
    pattern: { type: "string" }, path: { type: "string" }, type: { type: "string", enum: ["file","directory"] }, max_results: { type: "number" },
  }, [], ["repository:read"], 30_000, async (_ctx, a) => {
    const pat = (a.pattern as string) || "*"
    let rawPath = (a.path as string) || process.cwd()
    const pathCheck = validatePath(rawPath, false)
    if (!pathCheck.valid) return err(pathCheck.error || "path rejected")
    const searchPath = pathCheck.resolved
    const maxResults = (a.max_results as number) || 50
    const results: string[] = []
    async function walk(dir: string) {
      if (results.length >= maxResults) return
      let entries: Dirent[] = []
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue
        if (e.name === "node_modules" || e.name === ".git") continue
        const full = join(dir, e.name)
        const rel = relative(searchPath, full)
        if (rel.includes(pat.replace(/\*/g, "")) || pat === "*") {
          if (a.type === "directory" && e.isDirectory()) results.push(rel)
          else if (a.type === "file" && e.isFile()) results.push(rel)
          else if (!a.type) results.push(rel + (e.isDirectory() ? "/" : ""))
        }
        if (e.isDirectory()) await walk(full)
      }
    }
    await walk(resolve(searchPath))
    return ok({ pattern: pat, results: results.slice(0, maxResults), count: results.length })
  })

  register("tribunus_source_read", "Read a source file with structured digest.", {
    file: { type: "string" }, focus: { type: "string" }, summary_only: { type: "boolean" },
  }, ["file"], ["repository:read"], 15_000, async (_ctx, a) => {
    const filePath = a.file as string
    const pathCheck = validatePath(filePath, false)
    if (!pathCheck.valid) return err(pathCheck.error || "path rejected")
    const content = await readFile(pathCheck.resolved, "utf-8")
    const summary = a.summary_only
    if (summary) return ok({ file: filePath, lines: content.split("\n").length, size: content.length, preview: content.split("\n").slice(0, 5).join("\n") })
    return ok({ file: filePath, lines: content.split("\n").length, size: content.length, content })
  })

  // ── Code Intelligence (Oxc-based, native) ───────────────────────────

  register("tribunus_repository_map", "Rank the most important files and symbols from the Oxc semantic kernel snapshot.", {
    focus_paths: { type: "array", items: { type: "string" }, description: "Focus on specific paths" },
    focus_symbols: { type: "array", items: { type: "string" }, description: "Focus on specific symbols" },
    max_symbols: { type: "number", description: "Maximum symbols to return" },
    include_tests: { type: "boolean" },
    include_architecture: { type: "boolean" },
  }, [], ["repository:index"], 60_000, async (_ctx, a) => {
    const result = await semanticRepoMap(process.cwd(), {
      focus_paths: a.focus_paths as string[] | undefined,
      focus_symbols: a.focus_symbols as string[] | undefined,
      max_symbols: (a.max_symbols as number) || 50,
      include_tests: a.include_tests === true,
      include_architecture: a.include_architecture === true,
    })
    return ok(result)
  })

  register("tribunus_symbol_lookup", "Look up a symbol in the Oxc semantic kernel by name or ID.", {
    symbol_name: { type: "string", description: "Symbol name to look up" },
    symbol_id: { type: "string", description: "Symbol ID (alternative to name)" },
    path: { type: "string", description: "Limit to a specific file path" },
    include_references: { type: "boolean", description: "Include reference locations" },
    include_callers: { type: "boolean", description: "Include caller symbols" },
  }, [], ["repository:index"], 30_000, async (_ctx, a) => {
    if (!a.symbol_name && !a.symbol_id) return err("symbol_name or symbol_id required")
    const result = await symbolLookup(process.cwd(), {
      symbol_name: a.symbol_name as string | undefined,
      symbol_id: a.symbol_id as string | undefined,
      path: a.path as string | undefined,
      include_references: a.include_references === true,
      include_callers: a.include_callers === true,
    })
    return ok(result)
  })

  register("tribunus_impact_analysis", "Analyze the blast radius of a proposed change using the Oxc dependency graph.", {
    paths: { type: "array", items: { type: "string" }, description: "File paths affected by the change" },
    symbols: { type: "array", items: { type: "string" }, description: "Symbols affected by the change" },
    proposed_change_summary: { type: "string", description: "Description of the proposed change" },
    include_tests: { type: "boolean", description: "Include affected tests" },
  }, [], ["repository:index"], 60_000, async (_ctx, a) => {
    if (!a.paths && !a.symbols) return err("paths or symbols required")
    const result = await impactAnalysis(process.cwd(), {
      paths: a.paths as string[] | undefined,
      symbols: a.symbols as string[] | undefined,
      proposed_change_summary: a.proposed_change_summary as string | undefined,
      include_tests: a.include_tests === true,
    })
    return ok(result)
  })

  register("tribunus_authority_audit", "Audit authority-critical files and symbols from the Oxc semantic kernel.", {
    focus_tools: { type: "array", items: { type: "string" }, description: "Tool IDs to focus the audit on" },
  }, [], ["repository:index"], 60_000, async (_ctx, a) => {
    const result = await authorityAudit(process.cwd(), {
      tool_ids: a.focus_tools as string[] | undefined,
    })
    return ok(result)
  })

  register("tribunus_test_gap_report", "Analyze test coverage gaps using the Oxc semantic kernel. Returns a coverage matrix showing which files and symbols lack test coverage.", {
    focus_tools: { type: "array", items: { type: "string" }, description: "Tool IDs to focus the report on" },
  }, [], ["repository:index"], 60_000, async (_ctx, a) => {
    const result = await testGapReport(process.cwd(), {
      focus_tools: a.focus_tools as string[] | undefined,
    })
    return ok(result)
  })

  // ── Review Export (Oxc-based, native) ───────────────────────────────

  register("tribunus_code_review_export", "Export code review packets using the Oxc parser and review-export pipeline.", {
    profile: { type: "string", enum: ["bootstrap_review","gemini_code_review"], description: "Export profile" },
    output_dir: { type: "string", description: "Output directory for exported artifacts" },
  }, [], ["artifact:write"], 300_000, async (_ctx, a) => {
    const result = buildCodeReviewExport({
      repoRoot: process.cwd(),
      profile: (a.profile as "bootstrap_review" | "gemini_code_review") || "gemini_code_review",
    })
    return ok({
      profile: a.profile || "gemini_code_review",
      zip_path: result.zipPath,
      zip_sha256: result.zipSha256,
      zip_size: result.zipSize,
      file_count: result.includedFiles.length,
      warnings: result.warnings.length,
      dirty: result.isDirty,
      timing_ms: result.timingsMs,
    })
  })

  register("tribunus_review_packet_export", "Export the source review packet (Oxc source graph + review manifests).", {
    semantic_output_path: { type: "string", description: "Path for semantic output" },
    source_output_path: { type: "string", description: "Path for source output" },
    force: { type: "boolean", description: "Overwrite existing output (default: true)" },
  }, [], ["artifact:write"], 300_000, async (_ctx, a) => {
    const result = await reviewPacketExport(process.cwd(), {
      semantic_output_path: a.semantic_output_path as string | undefined,
      source_output_path: a.source_output_path as string | undefined,
      force: a.force !== false,
    })
    return ok(result)
  })

  register("tribunus_semantic_review_export", "Export the semantic v1 review packet for Gemini-style code review.", {
    output_path: { type: "string", description: "Output path for the semantic packet" },
    force: { type: "boolean", description: "Overwrite existing output (default: true)" },
  }, [], ["artifact:write"], 300_000, async (_ctx, a) => {
    const result = await semanticReviewPacketExport(process.cwd(), {
      output_path: a.output_path as string | undefined,
      force: a.force !== false,
    })
    return ok(result)
  })

  register("tribunus_review_verify", "Verify source-review and Gemini IR ZIPs contain required Oxc source-graph evidence.", {
    source_zip_path: { type: "string", description: "Path to source-review ZIP" },
    ir_zip_path: { type: "string", description: "Path to Gemini IR ZIP" },
  }, [], ["artifact:verify"], 120_000, async (_ctx, a) => {
    const result = await verifyReviewPackets(process.cwd(), {
      source_zip_path: a.source_zip_path as string | undefined,
      ir_zip_path: a.ir_zip_path as string | undefined,
    })
    return ok(result)
  })
}
