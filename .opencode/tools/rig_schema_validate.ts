import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Validate a JSON document against a JSON Schema.",
  args: {
    document: tool.schema.string().describe("JSON document to validate (as string)"),
    schema: tool.schema.string().describe("JSON Schema (as string)"),
  },
  async execute(args, context) {
    let doc: any, schema: any
    try { doc = JSON.parse(args.document); schema = JSON.parse(args.schema) } catch { return JSON.stringify({ status: "fail", error: "Invalid JSON in document or schema" }, null, 2) }

    // Basic structural validation
    const errors: string[] = []
    if (schema.type === "object" && schema.required) {
      for (const key of schema.required) {
        if (!(key in doc)) errors.push(`Missing required key: ${key}`)
      }
    }
    if (schema.type === "array" && !Array.isArray(doc)) errors.push("Expected array")
    if (schema.type === "object" && (typeof doc !== "object" || Array.isArray(doc))) errors.push("Expected object")

    return JSON.stringify({ status: errors.length === 0 ? "pass" : "fail", errors }, null, 2)
  },
})
