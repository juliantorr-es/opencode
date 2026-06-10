import { getCodeIntelligenceKernel } from "../indexer.js"
import type { TestGapQueryV1, TestGapReportV1 } from "../store/code-index-types.js"

export async function testGapReport(repoRoot: string, input: TestGapQueryV1): Promise<TestGapReportV1> {
  return getCodeIntelligenceKernel(repoRoot).getTestGaps(input)
}
