import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"
import { semanticRepoMap } from "./_lib/code-intelligence/queries/semantic-repo-map.js"
import { makeToolResponse } from "./_lib/code-intelligence/tool-response.js"

const factory: CustomToolFactory = (pi) => ({
  name: "semantic_repo_map",
  label: "Semantic Repo Map",
  description: "Rank the most important files and symbols in the current repo from the OMP semantic kernel snapshot.",
  parameters: pi.zod.object({
    focus_paths: pi.zod.array(pi.zod.string()).optional(),
    focus_symbols: pi.zod.array(pi.zod.string()).optional(),
    focus_authority_roles: pi.zod.array(pi.zod.string()).optional(),
    max_symbols: pi.zod.number().int().positive().optional(),
    max_bytes: pi.zod.number().int().positive().optional(),
    include_tests: pi.zod.boolean().optional(),
    include_architecture: pi.zod.boolean().optional(),
  }),
  async execute(_toolCallId, params) {
    const result = await semanticRepoMap(pi.cwd, params)
    return makeToolResponse(
      `Ranked ${result.ranked_files.length} files and ${result.ranked_symbols.length} symbols from snapshot ${result.snapshot_id}.`,
      result as Record<string, unknown>,
    )
  },
})

export default factory
