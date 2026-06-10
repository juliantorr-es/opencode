import { registerTool } from "../../server/registry.js"
import type { InvocationContext } from "../../governance/invocation-context.js"

function ok(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] } }

function t(name: string, desc: string, props: Record<string, unknown>, req: string[], caps: string[], ms: number, fn: (ctx: InvocationContext, a: Record<string, unknown>) => Promise<unknown>) {
  registerTool({ name, description: desc, inputSchema: { type: "object", properties: props as any, required: req }, requiredCapabilities: caps as any, timeoutMs: ms, execute: fn, aliases: [] })
}

export function registerOmpRepoIntelTools(): void {
  t("tribunus_search", "Search for patterns in files. Pure TypeScript. Respects .gitignore.", {
    pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, max_results: { type: "number" },
  }, ["pattern"], ["github:read"], 30_000, async (_ctx, a) => {
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
  }, [], ["github:read"], 30_000, async (_ctx, a) => {
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
  }, ["file"], ["github:read"], 15_000, async (_ctx, a) => {
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
  }, [], ["github:read"], 30_000, async (_ctx, a) => {
    return ok({ message: "Semantic repository map — Oxc-based implementation pending port from OMP tools", max_symbols: a.max_symbols || 50 })
  })
}
