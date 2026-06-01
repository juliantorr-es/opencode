import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { homedir } from "node:os"

function r(p: string): string { return resolve(p) }

// Read JSONC (strip comments, preserve intentional markers)
function readJSONC(path: string): any {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, "utf8")
  const clean = raw.replace(/\/\/[^\n]*/g, "").replace(/,\s*}/g, "}").replace(/,\s*\]/g, "]")
  try { return JSON.parse(clean) } catch { return {} }
}

// Check if a permission was intentionally blocked (ends with // intentional)
function isIntentional(raw: string, key: string): boolean {
  const lines = raw.split("\n")
  for (const line of lines) {
    if (line.includes(`"${key}"`) && line.includes("// intentional")) return true
  }
  return false
}

function writeJSON(path: string, data: any) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8")
}

export default tool({
  description: "Sync agent permissions and tool configs between global (~/.config/opencode/opencode.json) and local (opencode.jsonc) configs. Ensures both stay aligned. Call on startup or after adding new tools/agents.",
  args: {
    action: tool.schema.string().describe("'sync' to align both configs | 'check' to see differences | 'canonical' to write the canonical config"),
    direction: tool.schema.string().optional().describe("'both' (default) | 'local_to_global' | 'global_to_local'"),
  },
  async execute(args, context) {
    const globalPath = r(homedir(), ".config/opencode/opencode.json")
    const localPath = r(context.worktree, "opencode.jsonc")

    const global = readJSONC(globalPath)
    const local = readJSONC(localPath)

    if (args.action === "check") {
      const diffs: string[] = []

      // Check permissions at global level
      const gPerms = new Set(Object.keys(global.permission || {}))
      const lPerms = new Set(Object.keys(local.permission || {}))
      for (const p of lPerms) { if (!gPerms.has(p)) diffs.push(`Global missing permission: ${p}`) }
      for (const p of gPerms) { if (!lPerms.has(p)) diffs.push(`Local missing permission: ${p}`) }

      // Check agents
      const gAgents = new Set(Object.keys(global.agent || {}))
      const lAgents = new Set(Object.keys(local.agent || {}))
      for (const a of lAgents) { if (!gAgents.has(a)) diffs.push(`Global missing agent: ${a}`) }
      for (const a of gAgents) { if (!lAgents.has(a)) diffs.push(`Local missing agent: ${a}`) }

      // Check per-agent permissions
      for (const agent of [...lAgents, ...gAgents]) {
        const ga = global.agent?.[agent]?.permission || {}
        const la = local.agent?.[agent]?.permission || {}
        const gaKeys = new Set(Object.keys(ga))
        const laKeys = new Set(Object.keys(la))
        for (const k of laKeys) { if (!gaKeys.has(k)) diffs.push(`${agent}: global missing permission ${k}`) }
        for (const k of gaKeys) { if (!laKeys.has(k)) diffs.push(`${agent}: local missing permission ${k}`) }
      }

      return JSON.stringify({
        action: "check",
        differences: diffs.length,
        details: diffs.slice(0, 30),
        hint: diffs.length === 0 ? "Configs are aligned." : `Run config_sync(action='sync') to fix ${diffs.length} differences.`,
      }, null, 2)
    }

    if (args.action === "sync") {
      const direction = args.direction || "both"
      let changes = 0

      if (direction === "both" || direction === "local_to_global") {
        // Merge local → global: skip entries marked with // intentional
        if (!global.permission) global.permission = {}
        const globalRaw = existsSync(globalPath) ? readFileSync(globalPath, "utf8") : ""
        for (const [key, val] of Object.entries(local.permission || {})) {
          if (!(key in global.permission) && !isIntentional(globalRaw, key)) {
            global.permission[key] = val; changes++
          }
        }
        if (!global.agent) global.agent = {}
        for (const [agent, config] of Object.entries(local.agent || {})) {
          if (!global.agent[agent]) { global.agent[agent] = JSON.parse(JSON.stringify(config)); changes++; continue }
          const ac = config as any
          const gc = global.agent[agent]
          if (!gc.permission) gc.permission = {}
          for (const [key, val] of Object.entries(ac.permission || {})) {
            if (!(key in gc.permission)) { gc.permission[key] = val; changes++ }
          }
        }
        writeJSON(globalPath, global)
      }

      if (direction === "both" || direction === "global_to_local") {
        // Merge global → local
        if (!local.permission) local.permission = {}
        for (const [key, val] of Object.entries(global.permission || {})) {
          if (!(key in local.permission)) { local.permission[key] = val; changes++ }
        }
        if (!local.agent) local.agent = {}
        for (const [agent, config] of Object.entries(global.agent || {})) {
          if (!local.agent[agent]) { local.agent[agent] = JSON.parse(JSON.stringify(config)); changes++; continue }
          const ac = config as any
          const lc = local.agent[agent]
          if (!lc.permission) lc.permission = {}
          for (const [key, val] of Object.entries(ac.permission || {})) {
            if (!(key in lc.permission)) { lc.permission[key] = val; changes++ }
          }
        }
        writeJSON(localPath, local)
      }

      return JSON.stringify({
        action: "sync",
        status: "aligned",
        changes,
        direction,
        hint: `${changes} missing entries added. Both configs are now in sync.`,
      }, null, 2)
    }

    if (args.action === "canonical") {
      // Write the local config as the canonical source
      writeJSON(localPath, local)
      return JSON.stringify({ action: "canonical", status: "written", path: localPath }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: sync, check, canonical.` }, null, 2)
  },
})
