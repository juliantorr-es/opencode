import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

function resolvePath(worktree: string, p: string): string {
  return resolve(worktree, p)
}

function hb(context: any, tool: string, phase: string, detail: string) {
  try {
    const fs = require("node:fs")
    const dir = resolve(context.worktree, "docs/json/opencode/sessions/" + context.sessionID + "/analytics")
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(dir + "/heartbeat.v1.jsonl",
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
  description: "Search and replace text in files using fixed-string matching (not regex). Safer than sd/sed — no regex escaping surprises. Use this for literal text replacements.",
  args: {
    file: tool.schema.string().describe("File to modify"),
    old: tool.schema.string().describe("Exact text to replace — literal match, no regex"),
    new: tool.schema.string().describe("Replacement text"),
    reason: tool.schema.string().describe("Why this replacement is needed"),
  },
  async execute(args, context) {
    const filePath = resolvePath(context.worktree, args.file)
    const fs = require("node:fs")
    
    if (!fs.existsSync(filePath)) {
      return JSON.stringify({ status: "fail", error: `File not found: ${args.file}` }, null, 2)
    }
    
    const original = fs.readFileSync(filePath, "utf8")
    const count = original.split(args.old).length - 1
    
    if (count === 0) {
      // Show surrounding context to help debug
      const lines = original.split("\n")
      const oldFirstLine = args.old.split("\n")[0].trim()
      const matches: string[] = []
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(oldFirstLine.slice(0, 40))) {
          matches.push(`  line ${i+1}: ${lines[i].trim().slice(0, 200)}`)
        }
      }
      return JSON.stringify({
        status: "fail",
        error: "old text not found in file",
        hint: "Use read_source to see exact file content. Check whitespace and line endings.",
        similar_lines: matches.slice(0, 5),
      }, null, 2)
    }
    
    if (count > 1) {
      return JSON.stringify({
        status: "fail", 
        error: `old text matches ${count} times — must be unique`,
        hint: "Include more surrounding context to make the match unique.",
      }, null, 2)
    }
    
    const modified = original.replace(args.old, args.new)
    fs.writeFileSync(filePath, modified, "utf8")

    // Post-write verification: read back and confirm change persisted
    // Guards against silent failures from cross-lane file contention
    const verify = fs.readFileSync(filePath, "utf8")
    if (!verify.includes(args.new)) {
      return JSON.stringify({
        status: "fail",
        error: "Write verification failed — new text not found in file after write. This usually means another process modified the file simultaneously. Retry or use produce_fragment for shared files.",
        file: args.file,
      }, null, 2)
    }
    
    // Record edit metadata
    const editDir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/edits`)
    fs.mkdirSync(editDir, { recursive: true })
    const logLine = JSON.stringify({
      schema_version: "v1",
      session_id: context.sessionID,
      agent: context.agent,
      file: args.file,
      reason: args.reason,
      change_summary: "literal replacement",
      edited_at: new Date().toISOString(),
    })
    fs.appendFileSync(resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/edits/edit_log.v1.jsonl`), logLine + "\n", "utf8")

    // Analytics
    const logDir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/analytics`)
    try { if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true }) } catch (_) {}
    try {
      fs.appendFileSync(logDir + "/smart_tool_usage.v1.jsonl",
        JSON.stringify({ at: new Date().toISOString(), session_id: context.sessionID, agent: context.agent, tool: "smart_sd", file: args.file.slice(0, 120) }) + "\n", "utf8")
    } catch (_) {}
    
    artifactLog(context, { tool: "smart_sd", action: "replaced", file: args.file, detail: args.reason?.slice(0, 80) })
    hb(context, "smart_sd", "completed", `1 match in ${args.file}`)
    return JSON.stringify({
      status: "applied",
      file: args.file,
      occurrences_matched: 1,
      reason: args.reason,
      metadata_recorded: true,
    }, null, 2)
  },
})
