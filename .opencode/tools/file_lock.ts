import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Acquire and release file locks for shared files. Prevents multiple agents from editing the same file simultaneously. Always check before touching shared files, acquire before editing, and release after completion.",
  args: {
    action: tool.schema.string().describe("'check' to see lock status, 'acquire' to lock a file, 'release' to unlock a file, 'list' to see all active locks"),
    file: tool.schema.string().optional().describe("File path relative to worktree (for check/acquire/release)"),
  },
  async execute(args, context) {
    const lockDir = r(context.worktree, "docs/json/opencode/locks")
    try { if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true }) } catch (_) {}

    const lockFile = (file: string) => r(lockDir, file.replace(/\//g, "_") + ".lock")

    if (args.action === "list") {
      try {
        const { readdirSync } = require("fs")
        const locks = readdirSync(lockDir).filter((f: string) => f.endsWith(".lock"))
        const active = locks.map((l: string) => {
          const lockPath = r(lockDir, l)
          try {
            const data = JSON.parse(readFileSync(lockPath, "utf8"))
            const elapsed = Math.floor((Date.now() - new Date(data.acquired_at).getTime()) / 1000)
            return { file: l.replace(".lock", "").replace(/_/g, "/"), holder: data.holder, held_for_s: elapsed }
          } catch { return { file: l.replace(".lock", "").replace(/_/g, "/"), holder: "unknown" } }
        })
        return JSON.stringify({ action: "list", locks: active, total: active.length }, null, 2)
      } catch { return JSON.stringify({ action: "list", locks: [], total: 0 }, null, 2) }
    }

    if (!args.file) return JSON.stringify({ error: "Missing 'file' parameter." }, null, 2)

    const path = lockFile(args.file)

    if (args.action === "check") {
      if (existsSync(path)) {
        try {
          const data = JSON.parse(readFileSync(path, "utf8"))
          const elapsed = Math.floor((Date.now() - new Date(data.acquired_at).getTime()) / 1000)
          return JSON.stringify({
            action: "check", file: args.file, locked: true,
            holder: data.holder, held_for_s: elapsed,
            hint: `File locked by '${data.holder}' for ${elapsed}s. Coordinate with them or wait for release.`,
          }, null, 2)
        } catch { return JSON.stringify({ action: "check", file: args.file, locked: true, holder: "unknown" }, null, 2) }
      }
      return JSON.stringify({ action: "check", file: args.file, locked: false, hint: "File is free — acquire the lock before editing." }, null, 2)
    }

    if (args.action === "acquire") {
      if (existsSync(path)) {
        try {
          const data = JSON.parse(readFileSync(path, "utf8"))
          if (data.holder === context.agent) {
            return JSON.stringify({ action: "acquire", file: args.file, status: "already_held", holder: context.agent, hint: "You already hold this lock." }, null, 2)
          }
          return JSON.stringify({
            action: "acquire", file: args.file, status: "blocked",
            current_holder: data.holder,
            hint: `File locked by '${data.holder}'. Wait for release or coordinate with them.`,
          }, null, 2)
        } catch {
          return JSON.stringify({ action: "acquire", file: args.file, status: "blocked", hint: "File is locked but lock data is corrupted. Investigate." }, null, 2)
        }
      }
      try {
        writeFileSync(path, JSON.stringify({
          file: args.file, holder: context.agent, session_id: context.sessionID,
          acquired_at: new Date().toISOString(),
        }, null, 2))
      } catch (_) {}
      return JSON.stringify({ action: "acquire", file: args.file, status: "locked", holder: context.agent, hint: "Lock acquired. Remember to release it after your edits are committed." }, null, 2)
    }

    if (args.action === "release") {
      if (!existsSync(path)) {
        return JSON.stringify({ action: "release", file: args.file, status: "not_locked", hint: "File was not locked." }, null, 2)
      }
      try {
        const data = JSON.parse(readFileSync(path, "utf8"))
        if (data.holder !== context.agent) {
          return JSON.stringify({
            action: "release", file: args.file, status: "not_yours",
            actual_holder: data.holder,
            hint: `Lock is held by '${data.holder}', not you. You cannot release another agent's lock.`,
          }, null, 2)
        }
      } catch {}
      try { require("fs").unlinkSync(path) } catch (_) {}
      return JSON.stringify({ action: "release", file: args.file, status: "released" }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: check, acquire, release, list.` }, null, 2)
  },
})
