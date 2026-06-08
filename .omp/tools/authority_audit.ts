import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"
import { authorityAudit } from "./_lib/code-intelligence/queries/authority-audit.js"
import { makeToolResponse } from "./_lib/code-intelligence/tool-response.js"

const factory: CustomToolFactory = (pi) => ({
  name: "authority_audit",
  label: "Authority Audit",
  description: "Audit governed OMP tool and storage authority against the semantic kernel snapshot.",
  parameters: pi.zod.object({
    tool_ids: pi.zod.array(pi.zod.string()).optional(),
  }),
  async execute(_toolCallId, params) {
    const result = await authorityAudit(pi.cwd, params)
    return makeToolResponse(
      `Authority audit produced ${result.checks.length} check(s) and ${result.findings.length} finding(s).`,
      result as Record<string, unknown>,
    )
  },
})

export default factory
