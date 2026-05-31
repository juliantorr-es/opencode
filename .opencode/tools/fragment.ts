import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Fragment protocol — produce, mark ready, or consolidate fragments for shared files. Consolidation merges whatever is ready; call it repeatedly as more fragments complete.",
  args: {
    action: tool.schema.string().describe("produce | ready | consolidate"),
    target_file: tool.schema.string().optional().describe("Shared file (for produce)"),
    lane_id: tool.schema.string().optional().describe("Lane ID (for produce/ready)"),
    anchor_hint: tool.schema.string().optional().describe("Where to apply (for produce)"),
    content: tool.schema.string().optional().describe("Fragment content (for produce)"),
    dependencies: tool.schema.string().optional().describe("JSON array of lane deps (for produce)"),
    file: tool.schema.string().optional().describe("File to consolidate (for consolidate)"),
    expected_lanes: tool.schema.string().optional().describe("Comma-separated lane IDs (for consolidate)"),
  },
  async execute(args, context) {
    const fragDir = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/fragments`)

    // ── PRODUCE ──
    if (args.action === "produce") {
      try { if (!existsSync(fragDir)) mkdirSync(fragDir, { recursive: true }) } catch (_) {}
      let deps: string[] = []
      if (args.dependencies) { try { deps = JSON.parse(args.dependencies) } catch {} }
      const frag = {
        schema_version: "v1", target_file: args.target_file, lane_id: args.lane_id,
        anchor_hint: args.anchor_hint, content: args.content, dependencies: deps,
        produced_at: new Date().toISOString(), ready: false,
      }
      try { appendFileSync(r(fragDir, `${args.lane_id}.v1.json`), JSON.stringify(frag) + "\n", "utf8") } catch (_) {}
      return JSON.stringify({
        action: "produce", status: "draft", lane_id: args.lane_id, target_file: args.target_file,
        hint: "Fragment saved as draft. Call fragment(action='ready') when done.",
      }, null, 2)
    }

    // ── READY ──
    if (args.action === "ready") {
      const fp = r(fragDir, `${args.lane_id}.v1.json`)
      if (!existsSync(fp)) return JSON.stringify({ error: `No fragment for lane ${args.lane_id}` }, null, 2)
      try {
        const lines = readFileSync(fp, "utf8").split("\n").filter(Boolean)
        const updated = lines.map(l => {
          try { const f = JSON.parse(l); f.ready = true; f.ready_at = new Date().toISOString(); return JSON.stringify(f) } catch { return l }
        })
        writeFileSync(fp, updated.join("\n") + "\n", "utf8")
        return JSON.stringify({ action: "ready", lane_id: args.lane_id, status: "marked ready" }, null, 2)
      } catch { return JSON.stringify({ error: "Failed to mark ready" }, null, 2) }
    }

    // ── CONSOLIDATE (incremental — merges whatever is ready) ──
    if (args.action === "consolidate") {
      const targetPath = r(context.worktree, args.file || "")
      const expected = (args.expected_lanes || "").split(",").map(s => s.trim()).filter(Boolean)
      if (!existsSync(fragDir)) return JSON.stringify({ action: "consolidate", status: "waiting", ready: 0, expected: expected.length }, null, 2)

      const readyLanes: string[] = []
      const unreadyLanes: string[] = []
      for (const f of readdirSync(fragDir)) {
        if (!f.endsWith(".json")) continue
        try {
          const lines = readFileSync(r(fragDir, f), "utf8").split("\n").filter(Boolean)
          for (const line of lines) {
            try {
              const frag = JSON.parse(line)
              if (frag.target_file === args.file && expected.includes(frag.lane_id)) {
                if (frag.ready) readyLanes.push(frag.lane_id)
                else unreadyLanes.push(frag.lane_id)
              }
            } catch {}
          }
        } catch {}
      }

      const missingLanes = expected.filter(l => !readyLanes.includes(l) && !unreadyLanes.includes(l))
      const stillPending = [...unreadyLanes, ...missingLanes]

      // Merge whatever IS ready (may be none, some, or all)
      if (readyLanes.length > 0) {
        let merged = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : ""
        for (const lane of readyLanes) {
          const fp = r(fragDir, `${lane}.v1.json`)
          if (!existsSync(fp)) continue
          try {
            const lines = readFileSync(fp, "utf8").split("\n").filter(Boolean)
            for (const line of lines) {
              try {
                const frag = JSON.parse(line)
                if (frag.ready && frag.content) merged += `\n// --- ${frag.lane_id} ---\n${frag.content}`
              } catch {}
            }
          } catch {}
        }
        writeFileSync(targetPath, merged, "utf8")
      }

      let tc = "not_run"
      if (readyLanes.length > 0) {
        try { const r = spawnSync("bun", ["x", "tsgo", "--noEmit"], { encoding: "utf8", timeout: 30000 }); tc = r.status === 0 ? "pass" : "fail" } catch {}
      }

      return JSON.stringify({
        action: "consolidate",
        status: readyLanes.length > 0 ? "partial" : "waiting",
        merged: readyLanes,
        still_pending: stillPending,
        expected: expected.length,
        typecheck: tc,
        hint: stillPending.length > 0
          ? `${stillPending.length} lanes still pending. Run consolidate again when more fragments are ready.`
          : "All lanes merged.",
      }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: produce, ready, consolidate.` }, null, 2)
  },
})
