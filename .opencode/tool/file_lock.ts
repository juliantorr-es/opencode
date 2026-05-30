import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Acquire or release a file lock to prevent cross-lane write conflicts. Call lock(action='acquire') before editing a shared file, lock(action='release') after.",
  args: {
    file: tool.schema.string().describe("File to lock or unlock"),
    action: tool.schema.string().describe("acquire | release | check"),
  },
  async execute(args, context) {
    const lockDir = resolvePath(context.worktree, "docs/json/opencode/locks")
    const lockFile = resolve(lockDir, `${args.file.replace(/\//g, "_")}.lock`)
    try { mkdirSync(lockDir, { recursive: true }) } catch (_) {}

    if (args.action === "acquire") {
      if (existsSync(lockFile)) {
        const owner = readFileSync(lockFile, "utf8").trim()
        return JSON.stringify({
          status: "locked",
          file: args.file,
          owner_session: owner,
          hint: `File is locked by session ${owner.slice(0, 12)}. Either wait or escalate to General Management.`,
        }, null, 2)
      }
      writeFileSync(lockFile, `${context.sessionID}\n${context.agent}\n${new Date().toISOString()}`, "utf8")
      return JSON.stringify({ status: "acquired", file: args.file, session: context.sessionID }, null, 2)
    }

    if (args.action === "release") {
      if (existsSync(lockFile)) {
        try { unlinkSync(lockFile) } catch {}
        return JSON.stringify({ status: "released", file: args.file }, null, 2)
      }
      return JSON.stringify({ status: "not_locked", file: args.file }, null, 2)
    }

    // check
    if (existsSync(lockFile)) {
      const lockData = readFileSync(lockFile, "utf8").split("\n")
      const owner = lockData[0] || "unknown"
      const lockedAt = lockData[2] || ""

      // Cross-reference with heartbeats — auto-release if holder is dead
      let holderAlive = false
      try {
        const hbDir = resolvePath(context.worktree, `docs/json/opencode/sessions/${owner}/analytics`)
        const hbPath = resolve(hbDir, "heartbeat.v1.jsonl")
        if (existsSync(hbPath)) {
          const lines = readFileSync(hbPath, "utf8").split("\n").filter(Boolean)
          if (lines.length > 0) {
            const last = JSON.parse(lines[lines.length - 1])
            const age = (Date.now() - new Date(last.at).getTime()) / 1000
            holderAlive = age < 15
          }
        }
      } catch {}
      
      if (!holderAlive) {
        try { unlinkSync(lockFile) } catch {}
        return JSON.stringify({ status: "auto_released", file: args.file, previous_owner: owner, reason: "Holder has no recent heartbeat — lock auto-released." }, null, 2)
      }
      const age = (Date.now() - new Date(readFileSync(lockFile, "utf8").split("\n")[2] || 0).getTime()) / 1000
      return JSON.stringify({
        status: "locked",
        file: args.file,
        owner_session: owner,
        locked_seconds_ago: Math.floor(age),
        stale: age > 15,
        hint: age > 15 ? "Lock is stale (>15s) — safe to force-release." : "File is actively locked.",
      }, null, 2)
    }
    return JSON.stringify({ status: "free", file: args.file }, null, 2)
  },
})
