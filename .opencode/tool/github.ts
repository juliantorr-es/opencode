import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "GitHub operations — PR search and issue triage.",
  args: {
    action: tool.schema.string().describe("pr-search | triage"),
    query: tool.schema.string().optional().describe("Search query"),
    issue_url: tool.schema.string().optional().describe("Issue URL (for triage)"),
    action_label: tool.schema.string().optional().describe("Label to apply (for triage)"),
  },
  async execute(args, context) {
    return JSON.stringify({ action: args.action, status: "not_implemented", hint: "GitHub tools require API credentials. These stubs exist for interface compatibility." }, null, 2)
  },
})
