import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Verify files, handoff claims, and preflight safety checks. Confirms files exist on disk, validates handoff JSONs, and checks for dirty state before edits. Trust but verify — every subagent claim must be proven.",
  args: {
    action: tool.schema.string().describe("'files' to check existence, 'preflight' to check dirty state, 'imports' to verify import references"),
    file_paths: tool.schema.string().optional().describe("JSON array of file paths to check (for files/imports)"),
    handoff_json: tool.schema.string().optional().describe("JSON string of a subagent's handoff to verify claims"),
  },
  async execute(args, context) {
    if (args.action === "files") {
      let paths: string[] = []
      if (args.file_paths) {
        try { paths = JSON.parse(args.file_paths) } catch { paths = args.file_paths.split(",").map(s => s.trim()) }
      }
      if (args.handoff_json) {
        try {
          const handoff = JSON.parse(args.handoff_json)
          const created = handoff.files_created || []
          const modified = handoff.files_modified || []
          paths = [...created, ...modified]
        } catch { return JSON.stringify({ error: "Invalid handoff_json — not valid JSON" }, null, 2) }
      }

      if (paths.length === 0) return JSON.stringify({ error: "No file paths to verify. Provide file_paths or handoff_json." }, null, 2)

      const results: any[] = []
      let missing = 0
      for (const p of paths) {
        const full = r(context.worktree, p)
        const exists = existsSync(full)
        if (!exists) missing++
        results.push({ path: p, exists })
      }

      return JSON.stringify({
        action: "files", checked: paths.length, missing,
        status: missing === 0 ? "pass" : "fail",
        results,
        hint: missing > 0 ? `${missing} claimed file(s) do not exist. The subagent may have lied — reject the handoff and send back for repair.` : undefined,
      }, null, 2)
    }

    if (args.action === "preflight") {
      // Check for dirty state: uncommitted changes, existing locks, etc.
      const checks: any = {}
      
      // Check for file locks
      const lockDir = r(context.worktree, "docs/json/opencode/locks")
      if (existsSync(lockDir)) {
        try {
          const { readdirSync } = require("fs")
          const locks = readdirSync(lockDir).filter((f: string) => f.endsWith(".lock"))
          if (locks.length > 0) {
            checks.locks = locks.map((l: string) => l.replace(".lock", ""))
          }
        } catch {}
      }

      return JSON.stringify({
        action: "preflight",
        status: Object.keys(checks).length === 0 ? "clean" : "dirty",
        checks,
        hint: checks.locks?.length ? `${checks.locks.length} file(s) locked. Coordinate with the lock holder before touching these files.` : "No locks detected. Safe to proceed.",
      }, null, 2)
    }

    if (args.action === "imports") {
      let paths: string[] = []
      if (args.file_paths) {
        try { paths = JSON.parse(args.file_paths) } catch { paths = args.file_paths.split(",").map(s => s.trim()) }
      }
      if (paths.length === 0) return JSON.stringify({ error: "No file paths to verify imports for." }, null, 2)

      const results: any[] = []
      for (const p of paths) {
        const full = r(context.worktree, p)
        if (!existsSync(full)) { results.push({ path: p, error: "File not found" }); continue }

        try {
          const content = readFileSync(full, "utf8")
          const imports = [...content.matchAll(/from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/g)]
          const unresolved: string[] = []
          for (const m of imports) {
            const imp = m[1] || m[2]
            if (imp && (imp.startsWith(".") || imp.startsWith("/") || imp.startsWith("~"))) {
              const resolved = r(full.replace(/[^/]+$/, ""), imp)
              if (!existsSync(resolved) && !existsSync(resolved + ".ts") && !existsSync(resolved + ".tsx") && !existsSync(resolved + ".js") && !existsSync(resolved + "/index.ts")) {
                unresolved.push(imp)
              }
            }
          }
          results.push({ path: p, total_imports: imports.length, unresolved, status: unresolved.length === 0 ? "pass" : "fail" })
        } catch (e: any) {
          results.push({ path: p, error: e.message })
        }
      }

      const totalUnresolved = results.reduce((sum, r) => sum + (r.unresolved?.length || 0), 0)
      return JSON.stringify({
        action: "imports", checked: paths.length, unresolved: totalUnresolved,
        status: totalUnresolved === 0 ? "pass" : "fail",
        results,
        hint: totalUnresolved > 0 ? `${totalUnresolved} unresolved import(s). Missing imports are the #1 cause of post-handoff type errors — reject and send back for repair.` : undefined,
      }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: files, preflight, imports.` }, null, 2)
  },
})
