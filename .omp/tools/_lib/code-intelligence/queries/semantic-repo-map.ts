import { getCodeIntelligenceKernel } from "../indexer.js"
import type { RepoMapQueryV1, RepoMapResultV1 } from "../store/code-index-types.js"

export async function semanticRepoMap(repoRoot: string, input: RepoMapQueryV1): Promise<RepoMapResultV1> {
  return getCodeIntelligenceKernel(repoRoot).getRepoMap(input)
}
