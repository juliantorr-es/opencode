import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Generate a consolidated diff summary of all changes made in this session — files created, modified, deleted, net line counts, per-package breakdown.",
  args: {
    session_id: tool.schema.string().optional().describe("Session to summarize (defaults to current)"),
    format: tool.schema.string().optional().describe("summary | full — summary returns counts only, full includes file lists"),
  },
  async execute(args, context) {
    const sid = args.session_id || context.sessionID
    const editLogPath = resolvePath(context.worktree, `docs/json/opencode/sessions/${sid}/edits/edit_log.v1.jsonl`)

    const filesCreated = new Set<string>()
    const filesModified = new Set<string>()
    const filesDeleted = new Set<string>()
    const perPackage: Record<string, { count: number; created: number; modified: number }> = {}
    const agents: Record<string, number> = {}
    let totalEdits = 0

    // Read edit log
    if (existsSync(editLogPath)) {
      try {
        const lines = readFileSync(editLogPath, "utf8").split("\n").filter(Boolean)
        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            const fp = entry.file || ""
            const agent = entry.agent || "?"
            agents[agent] = (agents[agent] || 0) + 1
            totalEdits++

            let pkg = "root"
            if (fp.startsWith("packages/")) pkg = fp.split("/")[1]!
            else if (fp.startsWith(".")) pkg = "config"
            if (!perPackage[pkg]) perPackage[pkg] = { count: 0, created: 0, modified: 0 }

            const action = entry.change_summary || entry.action || ""
            if (action.includes("create") || action.includes("new")) {
              filesCreated.add(fp); perPackage[pkg]!.created++
            } else if (action.includes("delete") || action.includes("remove")) {
              filesDeleted.add(fp)
            } else {
              filesModified.add(fp); perPackage[pkg]!.modified++
            }
            perPackage[pkg]!.count++
          } catch {}
        }
      } catch (_) {}
    }

    // Git diff for line counts
    let netLines = "+0/-0"
    try {
      const r = spawnSync("git", ["diff", "--stat", "HEAD"], { encoding: "utf8", timeout: 10000 })
      if (r.status === 0 && r.stdout?.trim()) {
        const last = r.stdout.trim().split("\n").pop() || ""
        netLines = last.trim()
      }
    } catch (_) {}

    // Fallback: if edit log empty, get files from git
    if (totalEdits === 0) {
      try {
        const r = spawnSync("git", ["diff", "--name-status", "HEAD"], { encoding: "utf8", timeout: 10000 })
        if (r.status === 0 && r.stdout?.trim()) {
          for (const line of r.stdout.trim().split("\n")) {
            if (!line.trim()) continue
            const parts = line.split("\t")
            if (parts.length < 2) continue
            const [code, fp] = parts as [string, string]
            let pkg = "root"
            if (fp.startsWith("packages/")) pkg = fp.split("/")[1]!
            else if (fp.startsWith(".")) pkg = "config"
            if (!perPackage[pkg]) perPackage[pkg] = { count: 0, created: 0, modified: 0 }

            if (code.startsWith("A")) { filesCreated.add(fp); perPackage[pkg]!.created++ }
            else if (code.startsWith("D")) filesDeleted.add(fp)
            else { filesModified.add(fp); perPackage[pkg]!.modified++ }
            perPackage[pkg]!.count++
            totalEdits++
          }
        }
      } catch (_) {}
    }

    const output: any = {
      session: sid,
      files_created: filesCreated.size,
      files_modified: filesModified.size,
      files_deleted: filesDeleted.size,
      total_edits: totalEdits,
      net_lines: netLines,
      per_package: Object.fromEntries(
        Object.entries(perPackage).sort(([, a], [, b]) => b.count - a.count)
      ),
      agents_involved: Object.entries(agents).sort(([, a], [, b]) => b - a).slice(0, 10).map(([k, v]) => ({ [k]: v })),
    }

    if (args.format === "full") {
      output.created_list = [...filesCreated].sort()
      output.modified_list = [...filesModified].sort()
      output.deleted_list = [...filesDeleted].sort()
    }

    return JSON.stringify(output, null, 2)
  },
})
