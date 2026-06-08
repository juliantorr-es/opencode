import type { OmpToolManifestV1 } from "../types.js"
import { extractInputSchema } from "./shared.js"

export type OpenAiToolDef = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

export function ompToOpenAiTool(manifest: OmpToolManifestV1): OpenAiToolDef {
  const { properties, required } = extractInputSchema(manifest.input_schema)
  return {
    type: "function",
    function: {
      name: manifest.tool_id,
      description: manifest.description,
      parameters: {
        type: "object" as const,
        properties,
        required,
      },
      strict: manifest.authority.risk_level !== "read",
    },
  }
}

export function openAiResultToEnvelope(
  _manifest: OmpToolManifestV1,
  toolCallId: string,
  result: unknown,
): { tool_call_id: string; output: string } {
  return {
    tool_call_id: toolCallId,
    output: JSON.stringify(result),
  }
}
