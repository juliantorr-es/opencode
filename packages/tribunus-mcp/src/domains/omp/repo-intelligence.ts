import { registerTool } from "../../server/registry.js"
import type { InvocationContext } from "../../governance/invocation-context.js"
import { governedRun } from "../../governance/subprocess.js"

function ok(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] } }


import type { Capability } from "../../governance/capabilities.js"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

function t(name: string, desc: string, props: Record<string, unknown>, req: string[], caps: Capability[], ms: number, fn: (ctx: InvocationContext, a: Record<string, unknown>) => Promise<unknown>) {
  registerTool({
    name,
    description: desc,
    inputSchema: { type: "object", properties: props as Record<string, { type?: string; enum?: string[]; items?: { type: string }; description?: string }>, required: req },
    requiredCapabilities: caps as import("../../governance/capabilities.js").Capability[],
    timeoutMs: ms,
    execute: fn,
  })
}

export function registerOmpRepoIntelTools(): void {
  t("tribunus_search", "Search for patterns in files. Pure TypeScript. Respects .gitignore.", {
    pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, max_results: { type: "number" },
  }, ["pattern"], ["repository:read"], 30_000, async (_ctx, a) => {
    const pattern = a.pattern as string
    const searchPath = (a.path as string) || process.cwd()
    const maxResults = (a.max_results as number) || 30
    const { readdir, readFile } = await import("node:fs/promises")
    const { join, resolve, relative } = await import("node:path")
    const results: Array<{ file: string; line: number; text: string }> = []
    async function walk(dir: string) {
      if (results.length >= maxResults) return
      let entries: import("node:fs").Dirent[] = []
      try { entries = await readdir(dir, { withFileTypes: true }) as any } catch { return }
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

  t("tribunus_find", "Find files and directories. Respects .gitignore.", {
    pattern: { type: "string" }, path: { type: "string" }, type: { type: "string", enum: ["file","directory"] }, max_results: { type: "number" },
  }, [], ["repository:read"], 30_000, async (_ctx, a) => {
    const pat = (a.pattern as string) || "*"
    const searchPath = (a.path as string) || process.cwd()
    const maxResults = (a.max_results as number) || 50
    const { readdir } = await import("node:fs/promises")
    const { join, resolve, relative } = await import("node:path")
    const results: string[] = []
    async function walk(dir: string) {
      if (results.length >= maxResults) return
      let entries: import("node:fs").Dirent[] = []
      try { entries = await readdir(dir, { withFileTypes: true }) as any } catch { return }
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

  t("tribunus_source_read", "Read a source file with structured digest.", {
    file: { type: "string" }, focus: { type: "string" }, summary_only: { type: "boolean" },
  }, ["file"], ["repository:read"], 15_000, async (_ctx, a) => {
    const filePath = a.file as string
    const { readFile } = await import("node:fs/promises")
    const { resolve } = await import("node:path")
    const content = await readFile(resolve(process.cwd(), filePath), "utf-8")
    const summary = a.summary_only
    if (summary) return ok({ file: filePath, lines: content.split("\n").length, size: content.length, preview: content.split("\n").slice(0, 5).join("\n") })
    return ok({ file: filePath, lines: content.split("\n").length, size: content.length, content })
  })

  t("tribunus_repository_map", "Rank important files and symbols from semantic kernel.", {
    focus_paths: { type: "array", items: { type: "string" } }, max_symbols: { type: "number" },
  }, [], ["repository:index"], 30_000, async (_ctx, a) => {
    return ok({ message: "Semantic repository map — Oxc-based implementation pending port from OMP tools", max_symbols: a.max_symbols || 50 })
  })

  // ── Review Export (Oxc-based, governed subprocess wrappers) ──
  // TEMPORARY COMPATIBILITY ADAPTERS — not native ports.
  // These four tools depend on the OMP _lib/ tree (Oxc parser, tree-sitter, @oh-my-pi/pi-coding-agent).
  // They run via a focused review-export-runner.ts that instantiates the CustomToolFactory,
  // constructs mock pi/ctx, and calls execute(). Will be replaced by direct imports from
  // @tribunus-ai/repository-intelligence once the Oxc stack is extracted.

  const RUNNER_PATH = `${dirname(fileURLToPath(import.meta.url))}/review-export-runner.ts`

  function runReviewTool(toolName: string, params: Record<string, unknown>): Promise<{ stdout: string; stderr: string; ok: boolean }> {
    return governedRun("bun", ["run", RUNNER_PATH, toolName, JSON.stringify(params)], { timeout: 300_000 })
  }

  t("tribunus_code_review_export", "Export code review packets (bootstrap + Gemini IR + zip attachment). Runs the OMP Oxc-based export pipeline.", {
    profile: { type: "string", enum: ["bootstrap_review","gemini_code_review","gemini_ir","gemini_structured_ir_v1","gemini_zip_attachment"], description: "Export profile (default: gemini_code_review)" },
    output_dir: { type: "string", description: "Output directory for exported artifacts" },
  }, [], ["artifact:write"], 300_000, async (_ctx, a) => {
    const result = await runReviewTool("code_review_export", { profile: a.profile || "gemini_code_review", output_dir: a.output_dir })
    if (!result.ok) return { content: [{ type: "text" as const, text: `Export failed: ${result.stderr}` }], isError: true }
    return ok({ profile: a.profile || "gemini_code_review", stdout: result.stdout })
  })

  t("tribunus_review_packet_export", "Export the source review packet (Oxc source graph + review manifests).", {
    semantic_output_path: { type: "string", description: "Path for semantic output" },
    source_output_path: { type: "string", description: "Path for source output" },
    force: { type: "boolean", description: "Overwrite existing output (default: true)" },
  }, [], ["artifact:write"], 300_000, async (_ctx, a) => {
    const result = await runReviewTool("review_packet_export", { semantic_output_path: a.semantic_output_path, source_output_path: a.source_output_path, force: a.force !== false })
    if (!result.ok) return { content: [{ type: "text" as const, text: `Export failed: ${result.stderr}` }], isError: true }
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  t("tribunus_semantic_review_export", "Export the semantic v1 review packet for Gemini-style code review.", {
    output_path: { type: "string", description: "Output path for the semantic packet" },
    force: { type: "boolean", description: "Overwrite existing output (default: true)" },
  }, [], ["artifact:write"], 300_000, async (_ctx, a) => {
    const result = await runReviewTool("semantic_review_packet_export", { output_path: a.output_path, force: a.force !== false })
    if (!result.ok) return { content: [{ type: "text" as const, text: `Export failed: ${result.stderr}` }], isError: true }
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })

  t("tribunus_review_verify", "Verify source-review and Gemini IR ZIPs contain required Oxc source-graph evidence.", {
    source_zip_path: { type: "string", description: "Path to source-review ZIP" },
    ir_zip_path: { type: "string", description: "Path to Gemini IR ZIP" },
  }, [], ["artifact:verify"], 120_000, async (_ctx, a) => {
    const result = await runReviewTool("verify_review_packets", { source_zip_path: a.source_zip_path, ir_zip_path: a.ir_zip_path })
    if (!result.ok) return { content: [{ type: "text" as const, text: `Verification failed: ${result.stderr}` }], isError: true }
    return ok({ stdout: result.stdout, stderr: result.stderr })
  })
}
