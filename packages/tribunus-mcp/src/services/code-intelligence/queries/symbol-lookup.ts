import { getCodeIntelligenceKernel } from "../indexer.js"
import type { SymbolLookupQueryV1, SymbolLookupResultV1 } from "../store/code-index-types.js"

export async function symbolLookup(repoRoot: string, input: SymbolLookupQueryV1): Promise<SymbolLookupResultV1> {
  return getCodeIntelligenceKernel(repoRoot).lookupSymbol(input)
}
