import { tool } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Fragment producer — declare a file region this lane intends to modify. Used for shared-file coordination between parallel lanes. Produces a fragment with explicit anchor points so the consolidator can assemble non-conflicting edits. Never write directly to shared files — always produce a fragment first.",
  args: {
    action: tool.schema.string().describe("'produce' to declare a fragment, 'list' to see all fragments for a file, 'consolidate' to assemble non-conflicting fragments"),
    file: tool.schema.string().optional().describe("Target file (for produce/list/consolidate)"),
    anchor_start: tool.schema.string().optional().describe("Exact text before your edit region — the consolidator uses this to position your fragment"),
    anchor_end: tool.schema.string().optional().describe("Exact text after your edit region"),
    content: tool.schema.string().optional().describe("Your replacement content for this region (for produce)"),
    lane_id: tool.schema.string().optional().describe("Lane identifier (for produce). Auto-detected if omitted."),
    reason: tool.schema.string().optional().describe("Why this region is being claimed (for produce)"),
  },
  async execute(args, context) {
    const fragDir = r(context.worktree, "docs/json/opencode/fragments")
    try { if (!existsSync(fragDir)) mkdirSync(fragDir, { recursive: true }) } catch (_) {}

    const laneKey = args.lane_id || context.agent

    if (args.action === "list") {
      if (!args.file) return JSON.stringify({ error: "Missing 'file' parameter." }, null, 2)
      const fileKey = args.file.replace(/\//g, "_")
      const fragPath = r(fragDir, `${fileKey}.v1.jsonl`)
      
      const fragments: any[] = []
      if (existsSync(fragPath)) {
        try {
          for (const line of readFileSync(fragPath, "utf8").split("\n").filter(Boolean)) {
            try { fragments.push(JSON.parse(line)) } catch {}
          }
        } catch (_) {}
      }
      
      // Check for collisions
      const regions = fragments.map((f: any) => ({ lane: f.lane_id, start: f.anchor_start?.slice(0, 40), end: f.anchor_end?.slice(0, 40) }))
      const collisions = fragments.filter((f: any) =>
        fragments.some((g: any) => g.lane_id !== f.lane_id && g.anchor_start === f.anchor_start)
      )
      
      return JSON.stringify({
        action: "list", file: args.file, fragments: fragments.length,
        lanes: [...new Set(fragments.map((f: any) => f.lane_id))],
        collisions: collisions.length > 0 ? collisions.map((c: any) => ({ lane: c.lane_id, anchor: c.anchor_start?.slice(0, 40) })) : undefined,
        regions,
        hint: collisions.length > 0 ? `${collisions.length} collision(s) detected — fragments share the same anchor. Resolve before consolidating.` : undefined,
      }, null, 2)
    }

    if (args.action === "produce") {
      if (!args.file || !args.anchor_start || !args.content) {
        return JSON.stringify({ error: "Missing required fields: file, anchor_start, content." }, null, 2)
      }
      
      const fileKey = args.file.replace(/\//g, "_")
      const fragPath = r(fragDir, `${fileKey}.v1.jsonl`)
      
      // Check for existing fragments at the same anchor
      let collision = false
      if (existsSync(fragPath)) {
        try {
          for (const line of readFileSync(fragPath, "utf8").split("\n").filter(Boolean)) {
            try {
              const existing = JSON.parse(line)
              if (existing.anchor_start === args.anchor_start && existing.lane_id !== laneKey) {
                collision = true
                break
              }
            } catch {}
          }
        } catch (_) {}
      }

      const fragment = {
        schema_version: "v2",
        file: args.file, lane_id: laneKey,
        anchor_start: args.anchor_start, anchor_end: args.anchor_end || "",
        content: args.content, reason: args.reason || "",
        produced_by: context.agent, session_id: context.sessionID,
        produced_at: new Date().toISOString(),
      }

      try { appendFileSync(fragPath, JSON.stringify(fragment) + "\n", "utf8") } catch (_) {}

      return JSON.stringify({
        action: "produce", status: collision ? "collision" : "produced",
        file: args.file, lane: laneKey,
        anchor: args.anchor_start.slice(0, 60),
        collision: collision ? { warning: "Another lane already claimed this anchor. Coordinate before consolidating." } : undefined,
        hint: collision ? "Resolve the collision with the other lane before consolidating." : "Fragment produced. Wait for all lanes to produce fragments, then consolidate.",
      }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: produce, list.` }, null, 2)
  },
})
