import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Write an initial canonical plan artifact under docs/json/opencode/plans/. Validates inputs and auto-generates plan IDs.",
  args: {
    plan_id: tool.schema.string().optional().describe("Unique plan identifier (kebab-case). Auto-generated from boundary if omitted."),
    title: tool.schema.string().describe("Human-readable plan title"),
    boundary: tool.schema.string().describe("Intended narrow boundary name"),
    consumer_purpose: tool.schema.string().describe("Consumer purpose for this boundary"),
    claim_atoms: tool.schema.string().describe("Claim atoms — accepts: JSON array string, native array, or comma-separated list"),
    content: tool.schema.string().describe("Full plan content"),
    dry_run: tool.schema.boolean().optional().describe("Validate and preview without writing"),
  },
  async execute(args, context) {
    // Robust claim_atoms parser — handles multiple input formats
    const raw = args.claim_atoms
    let claimAtoms: string[] = []

    const parseInput = (input: any): string[] | null => {
      if (Array.isArray(input)) return input.filter((a: any) => typeof a === "string")
      if (typeof input !== "string" || !input.trim()) return null
      const trimmed = input.trim()
      // JSON parse
      try { const p = JSON.parse(trimmed); if (Array.isArray(p)) return p.filter((a: any) => typeof a === "string") } catch {}
      // Double-encoded
      try { const u = JSON.parse(trimmed); if (typeof u === "string") { const i = JSON.parse(u); if (Array.isArray(i)) return i.filter((a: any) => typeof a === "string") } } catch {}
      // Comma-separated
      if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
        const parts = trimmed.split(",").map(s => s.trim()).filter(Boolean)
        if (parts.length > 0) return parts
      }
      return null
    }

    const result = parseInput(raw)
    if (!result || result.length === 0) {
      return JSON.stringify({ status: "validation_error", error: "claim_atoms could not be parsed", received: String(raw).slice(0, 100), accepted_formats: ["JSON string", "native array", "comma-separated"], debug_typeof: typeof raw }, null, 2)
    }
    claimAtoms = result

    const planId = args.plan_id ?? args.boundary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(planId) || planId.length < 3) {
      return JSON.stringify({ status: "validation_error", error: `Invalid plan_id '${planId}'`, hint: "Must be kebab-case, 3+ chars" }, null, 2)
    }

    if (args.dry_run) {
      return JSON.stringify({
        status: "dry_run",
        preview: { plan_id: planId, title: args.title, boundary: args.boundary, consumer_purpose: args.consumer_purpose, claim_atoms: claimAtoms, content_preview: args.content.slice(0, 300), revision: 1 },
        note: "No file written. Remove dry_run=true to create.",
      }, null, 2)
    }

    const dir = resolvePath(context.worktree, "docs/json/opencode/plans")
    const path = resolvePath(context.worktree, `docs/json/opencode/plans/${planId}.v1.json`)

    if (existsSync(path)) {
      return JSON.stringify({ status: "conflict", error: `Plan artifact already exists: ${path}`, action: "Use revise_plan to update the existing plan." }, null, 2)
    }

    try { mkdirSync(dir, { recursive: true }) } catch (_) {}

    const artifact = {
      schema_version: "v1", plan_id: planId, plan_revision: 1,
      title: args.title, boundary: args.boundary, consumer_purpose: args.consumer_purpose,
      claim_atoms: claimAtoms, content: args.content,
      status: "proposed",
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString(),
    }
    writeFileSync(path, JSON.stringify(artifact, null, 2), "utf8")
    return JSON.stringify({ status: "created", plan_id: planId, revision: 1, path, claim_count: claimAtoms.length }, null, 2)
  },
})
