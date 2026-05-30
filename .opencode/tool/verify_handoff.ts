import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

const REQUIRED_FIELDS = ["status", "files_created", "files_modified", "verification", "blockers", "deferred"]
const VALID_STATUSES = ["completed", "failed", "partial", "blocked", "frozen", "cancelled"]

export default tool({
  description: "Validate a subagent's handoff JSON against the required contract.",
  args: {
    handoff_json: tool.schema.string().describe("The handoff JSON string to validate"),
  },
  async execute(args, context) {
    let handoff: any
    try { handoff = JSON.parse(args.handoff_json) } catch { return JSON.stringify({ status: "fail", errors: ["Invalid JSON — not parseable"] }, null, 2) }

    const errors: string[] = []
    for (const field of REQUIRED_FIELDS) {
      if (!(field in handoff)) errors.push(`Missing required field: ${field}`)
    }
    if (handoff.status && !VALID_STATUSES.includes(handoff.status)) {
      errors.push(`Invalid status '${handoff.status}'. Valid: ${VALID_STATUSES.join(", ")}`)
    }
    if (handoff.files_created && !Array.isArray(handoff.files_created)) errors.push("files_created must be an array")
    if (handoff.files_modified && !Array.isArray(handoff.files_modified)) errors.push("files_modified must be an array")
    if (handoff.verification && typeof handoff.verification !== "object") errors.push("verification must be an object")

    return JSON.stringify({
      status: errors.length === 0 ? "pass" : "fail",
      errors,
      fields_present: REQUIRED_FIELDS.filter(f => f in handoff),
      fields_missing: REQUIRED_FIELDS.filter(f => !(f in handoff)),
    }, null, 2)
  },
})
