import type { OmpToolManifestV1 } from "../types.js"
import { extractInputSchema } from "./shared.js"

export type MistralFunctionDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export function ompToMistralFunction(manifest: OmpToolManifestV1): MistralFunctionDef {
  return {
    name: manifest.tool_id,
    description: manifest.description,
    parameters: extractInputSchema(manifest.input_schema),
  }
}

export function mistralResultToEnvelope(
  _manifest: OmpToolManifestV1,
  result: unknown,
): { tool_call_id: string; content: string } {
  return {
    tool_call_id: `omp_${_manifest.tool_id}`,
    content: JSON.stringify(result),
  }
}
