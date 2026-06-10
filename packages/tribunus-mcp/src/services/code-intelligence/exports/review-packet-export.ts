import { getCodeIntelligenceKernel } from "../indexer.js"
import type { PairedReviewExportInputV1, PairedReviewExportResultV1 } from "../store/code-index-types.js"

export async function reviewPacketExport(
  repoRoot: string,
  input: PairedReviewExportInputV1 = {},
): Promise<PairedReviewExportResultV1> {
  return getCodeIntelligenceKernel(repoRoot).exportPairedReviewPacket(input)
}
