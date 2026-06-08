import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"
import { impactAnalysis } from "./_lib/code-intelligence/queries/impact-analysis.js"
import { makeToolResponse } from "./_lib/code-intelligence/tool-response.js"

const factory: CustomToolFactory = (pi) => ({
  name: "impact_analysis",
  label: "Impact Analysis",
  description: "Analyze the blast radius of a proposed change using the OMP semantic kernel snapshot.",
  parameters: pi.zod.object({
    paths: pi.zod.array(pi.zod.string()).optional(),
    symbols: pi.zod.array(pi.zod.string()).optional(),
    proposed_change_summary: pi.zod.string().optional(),
    include_tests: pi.zod.boolean().optional(),
    include_manifests: pi.zod.boolean().optional(),
    include_migrations: pi.zod.boolean().optional(),
  }),
  async execute(_toolCallId, params) {
    const result = await impactAnalysis(pi.cwd, params)
    return makeToolResponse(
      `Impact analysis touches ${result.affected_files.length} file(s), ${result.affected_symbols.length} symbol(s), and ${result.affected_tests.length} test(s).`,
      result as Record<string, unknown>,
    )
  },
})

export default factory
