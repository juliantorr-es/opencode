import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Check if all expected fragments for a shared file are ready, and if so, consolidate them in dependency order. Call this after all secretaries report their fragments.",
  args: {
    target_file: tool.schema.string().describe("The shared file being consolidated"),
    expected_lanes: tool.schema.string().describe("Comma-separated lane IDs that should produce fragments (e.g. 'lane-1,lane-2,lane-4')"),
  },
  async execute(args, context) {
    const fragDir = resolvePath(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/fragments`)
    const targetPath = resolvePath(context.worktree, args.target_file)
    const expected = args.expected_lanes.split(",").map(s => s.trim()).filter(Boolean)

    if (!existsSync(fragDir)) {
      return JSON.stringify({ status: "waiting", ready: 0, expected: expected.length, hint: "No fragments directory yet." }, null, 2)
    }

    // Check which lanes have submitted fragments
    const submitted: string[] = []
    for (const f of readdirSync(fragDir)) {
      if (!f.endsWith(".json")) continue
      try {
        const frag = JSON.parse(readFileSync(resolve(fragDir, f), "utf8"))
        if (frag.target_file === args.target_file && expected.includes(frag.lane_id)) {
          submitted.push(frag.lane_id)
        }
      } catch {}
    }

    const missing = expected.filter(l => !submitted.includes(l))
    
    if (missing.length > 0) {
      return JSON.stringify({
        status: "waiting",
        ready: submitted.length,
        expected: expected.length,
        missing_lanes: missing,
        hint: `Waiting for fragments from: ${missing.join(", ")}`,
      }, null, 2)
    }

    // All fragments ready — consolidate
    const original = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : ""
    let consolidated = original
    const applied: string[] = []

    for (const lane of expected) {
      // Find fragment file for this lane
      const fragFile = resolve(fragDir, `${lane}.v1.json`)
      if (!existsSync(fragFile)) continue
      try {
        const frag = JSON.parse(readFileSync(fragFile, "utf8"))
        if (frag.content) {
          // Simple append consolidation — fragments insert at anchor points
          if (frag.anchor_hint && consolidated.includes(frag.anchor_hint)) {
            consolidated = consolidated.replace(frag.anchor_hint, `${frag.anchor_hint}\n${frag.content}`)
          } else {
            consolidated += `\n// --- ${frag.lane_id} ---\n${frag.content}`
          }
          applied.push(frag.lane_id)
        }
      } catch {}
    }

    writeFileSync(targetPath, consolidated, "utf8")

    // Run typecheck on the result
    let typecheckResult = "not_run"
    try {
      const tc = spawnSync("bun", ["x", "tsgo", "--noEmit"], { encoding: "utf8", timeout: 30000 })
      typecheckResult = tc.status === 0 ? "pass" : `fail (${(tc.stderr || "").split("\n").length} errors)`
    } catch { typecheckResult = "error" }

    return JSON.stringify({
      status: "consolidated",
      file: args.target_file,
      lanes_applied: applied,
      lanes_total: expected.length,
      typecheck: typecheckResult,
      hint: typecheckResult === "pass" ? "Consolidation clean." : "Typecheck failed after consolidation — review the merged file.",
    }, null, 2)
  },
})
