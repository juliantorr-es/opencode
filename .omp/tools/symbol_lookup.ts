import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"
import { symbolLookup } from "./_lib/code-intelligence/queries/symbol-lookup.js"
import { makeToolResponse } from "./_lib/code-intelligence/tool-response.js"

const factory: CustomToolFactory = (pi) => ({
  name: "symbol_lookup",
  label: "Symbol Lookup",
  description: "Look up a symbol in the OMP semantic kernel and return its definitions, references, callers, and tests.",
  parameters: pi.zod.object({
    symbol_name: pi.zod.string().optional(),
    symbol_id: pi.zod.string().optional(),
    path: pi.zod.string().optional(),
    include_references: pi.zod.boolean().optional(),
    include_callers: pi.zod.boolean().optional(),
    include_tests: pi.zod.boolean().optional(),
  }),
  async execute(_toolCallId, params) {
    const result = await symbolLookup(pi.cwd, params)
    return makeToolResponse(
      `Found ${result.symbols.length} symbol result(s) in the current snapshot.`,
      result as Record<string, unknown>,
    )
  },
})

export default factory
