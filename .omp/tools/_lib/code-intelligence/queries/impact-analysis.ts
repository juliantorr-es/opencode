import { getCodeIntelligenceKernel } from "../indexer.js"
import type { ImpactAnalysisQueryV1, ImpactAnalysisResultV1 } from "../store/code-index-types.js"

export async function impactAnalysis(repoRoot: string, input: ImpactAnalysisQueryV1): Promise<ImpactAnalysisResultV1> {
  return getCodeIntelligenceKernel(repoRoot).analyzeImpact(input)
}
