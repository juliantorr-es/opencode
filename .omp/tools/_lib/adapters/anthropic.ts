import type { OmpToolManifestV1 } from "../types.js"
import { extractInputSchema } from "./shared.js"

export type AnthropicToolDef = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export function ompToAnthropicTool(manifest: OmpToolManifestV1): AnthropicToolDef {
  const { properties, required } = extractInputSchema(manifest.input_schema)
  return {
    name: manifest.tool_id,
    description: manifest.description,
    input_schema: {
      type: "object" as const,
      properties,
      required,
    },
  }
}

export function anthropicResultToEnvelope(
  _manifest: OmpToolManifestV1,
  toolUseId: string,
  result: unknown,
): { type: "tool_result"; tool_use_id: string; content: string } {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(result),
  }
}
