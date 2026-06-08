import type { OmpToolManifestV1 } from "../types.js"
import { extractInputSchema } from "./shared.js"

export type McpToolDef = {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
}

export function ompToMcpTool(manifest: OmpToolManifestV1): McpToolDef {
  const { properties, required } = extractInputSchema(manifest.input_schema)
  return {
    name: manifest.tool_id,
    description: manifest.description,
    inputSchema: {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
    },
  }
}

export function mcpResultToEnvelope(
  _manifest: OmpToolManifestV1,
  result: unknown,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
  }
}
