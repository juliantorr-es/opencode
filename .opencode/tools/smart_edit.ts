import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

function hb(context: any, tool: string, phase: string, detail: string) {
  try {
    const dir = resolve(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(dir + "/heartbeat.v1.jsonl",
      JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, tool, phase, detail: detail.slice(0, 200) }) + "\n", "utf8")
  } catch (_) {}
}

function artifactLog(context: any, event: Record<string, unknown>) {
  try {
    const dir = resolve(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/artifacts`)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(resolve(dir, `${context.sessionID}.v1.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8")
  } catch (_) {}
}

export default tool({
  description: "Edit files with exact text replacement. Every edit is validated before application. Returns before/after diffs for every change. Use smart_batch for multi-file atomic edits.",
  args: {
    file_path: tool.schema.string().describe("Path to the file to edit (relative to worktree)"),
    old_text: tool.schema.string().describe("Exact text to replace — must match exactly including whitespace"),
    new_text: tool.schema.string().describe("Replacement text"),
    reason: tool.schema.string().optional().describe("Why this edit is being made — for the edit log"),
    replace_all: tool.schema.boolean().optional().describe("Replace all occurrences (default: replace first only)"),
  },
  async execute(args, context) {
    hb(context, "smart_edit", "started", args.file_path?.slice(0, 80) || "")
    const fullPath = r(context.worktree, args.file_path)

    if (!existsSync(fullPath)) {
      hb(context, "smart_edit", "failed", "file not found")
      return JSON.stringify({ status: "error", error: `File not found: ${args.file_path}` }, null, 2)
    }

    let content: string
    try { content = readFileSync(fullPath, "utf8") } catch (e: any) {
      return JSON.stringify({ status: "error", error: `Cannot read file: ${e.message}` }, null, 2)
    }

    const oldText = args.old_text
    const newText = args.new_text
    
    // Validate old_text exists in file
    const occurrences = content.split(oldText).length - 1
    if (occurrences === 0) {
      hb(context, "smart_edit", "failed", "text not found")
      // Show surrounding context to help
      const lines = content.split("\n")
      const snippet = lines.slice(0, 10).join("\n")
      return JSON.stringify({
        status: "error",
        error: "old_text not found in file. The text must match exactly including whitespace and indentation.",
        hint: "Check for trailing whitespace, tabs vs spaces, or line ending differences.",
        file_head: snippet.slice(0, 500),
      }, null, 2)
    }
    
    if (occurrences > 1 && !args.replace_all) {
      return JSON.stringify({
        status: "ambiguous",
        error: `old_text found ${occurrences} times in the file.`,
        hint: "Use replace_all: true to replace all occurrences, or make your old_text more specific to match only one location.",
        occurrences,
      }, null, 2)
    }

    const newContent = args.replace_all ? content.replaceAll(oldText, newText) : content.replace(oldText, newText)

    // Write
    try { writeFileSync(fullPath, newContent, "utf8") } catch (e: any) {
      return JSON.stringify({ status: "error", error: `Cannot write file: ${e.message}` }, null, 2)
    }

    // Generate diff
    const diffResult = spawnSync("git", ["-C", context.worktree, "diff", "--", args.file_path], {
      encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000,
    })
    const diff = diffResult.stdout?.trim() || "(no diff available)"

    hb(context, "smart_edit", "completed", args.file_path?.slice(0, 80) || "")
    artifactLog(context, { tool: "smart_edit", action: "edited", file: args.file_path, reason: args.reason, occurrences: args.replace_all ? occurrences : 1 })

    return JSON.stringify({
      status: "applied",
      file: args.file_path,
      occurrences: args.replace_all ? occurrences : 1,
      reason: args.reason || "",
      diff: diff.slice(0, 3000),
      hint: "Edit applied. Run verification (typecheck, tests) to confirm the change is correct.",
    }, null, 2)
  },
})
