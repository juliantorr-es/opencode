import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"
import { testGapReport } from "./_lib/code-intelligence/queries/test-gap-report.js"
import { makeToolResponse } from "./_lib/code-intelligence/tool-response.js"

const factory: CustomToolFactory = (pi) => ({
  name: "test_gap_report",
  label: "Test Gap Report",
  description: "Report test coverage gaps for the current OMP semantic kernel snapshot.",
  parameters: pi.zod.object({
    focus_tools: pi.zod.array(pi.zod.string()).optional(),
  }),
  async execute(_toolCallId, params) {
    const result = await testGapReport(pi.cwd, params)
    return makeToolResponse(
      `Test gap report contains ${result.coverage_matrix.length} coverage row(s) and ${result.gaps.length} gap(s).`,
      result as Record<string, unknown>,
    )
  },
})

export default factory
