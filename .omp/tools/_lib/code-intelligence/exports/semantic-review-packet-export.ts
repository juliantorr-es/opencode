import { getCodeIntelligenceKernel } from "../indexer.js"
import type { SemanticReviewExportInputV1, SemanticReviewExportResultV1 } from "../store/code-index-types.js"

export async function semanticReviewPacketExport(
  repoRoot: string,
  input: SemanticReviewExportInputV1 = {},
): Promise<SemanticReviewExportResultV1> {
  return getCodeIntelligenceKernel(repoRoot).exportSemanticReviewPacket(input)
}
