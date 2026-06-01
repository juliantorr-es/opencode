import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { init, absorbArtifact, readArtifact, listArtifacts } from "./db"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Read anything — artifacts, library types, or coordination messages. One tool for all read operations.",
  args: {
    action: tool.schema.string().describe("artifact | lib | messages"),
    path: tool.schema.string().optional().describe("File path (for artifact) or package name (for lib)"),
    file: tool.schema.string().optional().describe("File within package (for lib, e.g. 'Layer.d.ts')"),
    symbol: tool.schema.string().optional().describe("Symbol to look up (for lib, e.g. 'provideMerge')"),
    kind: tool.schema.string().optional().describe("Message kind filter (for messages)"),
    recipient: tool.schema.string().optional().describe("Recipient filter (for messages)"),
    sender: tool.schema.string().optional().describe("Sender filter (for messages)"),
    lane_prefix: tool.schema.string().optional().describe("Only show messages from lanes starting with this prefix (for messages, e.g. 'tc-')."),
    session_id: tool.schema.string().optional().describe("Only show messages from this session (for messages)."),
    limit: tool.schema.number().optional().describe("Max results (for messages, default 20)"),
  },
  async execute(args, context) {
    // ── ARTIFACT ──
    if (args.action === "artifact") {
      const db = init(context.worktree)
      // Try DB first
      const dbResult = readArtifact(db, args.path || "")
      if (dbResult) {
        return JSON.stringify({ action: "artifact", status: "loaded", path: args.path, data: dbResult, source: "database" }, null, 2)
      }
      // Fall back to filesystem
      const fullPath = r(context.worktree, args.path || "")
      if (!existsSync(fullPath)) return JSON.stringify({ action: "artifact", status: "not_found", path: args.path }, null, 2)
      try {
        const content = readFileSync(fullPath, "utf8")
        let data: any
        try { data = JSON.parse(content) } catch { data = { raw: content.slice(0, 50000) } }
        return JSON.stringify({ action: "artifact", status: "loaded", path: args.path, data, size_bytes: content.length }, null, 2)
      } catch { return JSON.stringify({ action: "artifact", status: "fail" }, null, 2) }
    }

    // ── LIB ──
    if (args.action === "lib") {
      let pkgPath = r(context.worktree, `node_modules/${args.path}`)
      if (!existsSync(pkgPath)) pkgPath = r(context.worktree, `../../node_modules/${args.path}`)
      if (!existsSync(pkgPath)) return JSON.stringify({ action: "lib", status: "not_found", package: args.path }, null, 2)

      let filePath = args.file ? resolve(pkgPath, args.file) : resolve(pkgPath, "package.json")
      if (!existsSync(filePath)) {
        for (const c of [resolve(pkgPath, "dist", args.file || ""), resolve(pkgPath, "src", args.file || "")]) {
          if (existsSync(c)) { filePath = c; break }
        }
      }
      if (!existsSync(filePath)) return JSON.stringify({ action: "lib", status: "not_found", file: args.file }, null, 2)

      const content = readFileSync(filePath, "utf8")
      if (args.symbol) {
        const lines = content.split("\n")
        const matches: string[] = []
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.includes(args.symbol)) {
            const start = Math.max(0, i - 2), end = Math.min(lines.length, i + 5)
            matches.push(lines.slice(start, end).map((l, j) => `${start + j + 1}: ${l}`).join("\n"))
            if (matches.length >= 3) break
          }
        }
        return JSON.stringify({ action: "lib", status: "found", package: args.path, symbol: args.symbol, matches, count: matches.length }, null, 2)
      }
      return JSON.stringify({ action: "lib", status: "loaded", package: args.path, preview: content.slice(0, 10000) }, null, 2)
    }

    // ── MESSAGES ──
    if (args.action === "messages") {
      const db = init(context.worktree)
      let query = `SELECT * FROM messages WHERE 1=1`
      const params: any[] = []
      if (args.kind) { query += ` AND kind = ?`; params.push(args.kind) }
      if (args.recipient) { query += ` AND recipient = ?`; params.push(args.recipient) }
      if (args.sender) { query += ` AND sender = ?`; params.push(args.sender) }
      if (args.session_id) { query += ` AND session_id = ?`; params.push(args.session_id) }
      if (args.lane_prefix) { query += ` AND lane_id LIKE ?`; params.push(args.lane_prefix + "%") }
      query += ` ORDER BY sent_at DESC LIMIT ?`
      const limit = args.limit ?? 20
      params.push(limit)

      const rows = db.query(query).all(...params) as any[]
      const msgs = rows.map((e: any) => ({
        message_id: e.message_id, kind: e.kind, sender: e.sender, recipient: e.recipient,
        lane_id: e.lane_id, subject: e.subject,
        body: (e.body || "").slice(0, 2000), sent_at: e.sent_at,
      }))

      const totalRow = db.query(`SELECT COUNT(*) as cnt FROM messages`).get() as any
      return JSON.stringify({ action: "messages", messages: msgs, count: msgs.length,
        total_in_db: totalRow?.cnt || 0 }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'` }, null, 2)
  },
})
