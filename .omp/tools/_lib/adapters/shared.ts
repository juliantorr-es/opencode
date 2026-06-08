/**
 * Safely extract `properties` and `required` from an OMP input_schema
 * (typed as `unknown`) without resorting to `any`.
 */
export function extractInputSchema(
  schema: unknown,
): { properties: Record<string, unknown>; required: string[] } {
  if (!schema || typeof schema !== "object") {
    return { properties: {}, required: [] }
  }

  const obj = schema as Record<string, unknown>

  let properties: Record<string, unknown> = {}
  if (obj.properties && typeof obj.properties === "object") {
    properties = obj.properties as Record<string, unknown>
  }

  let required: string[] = []
  if (Array.isArray(obj.required)) {
    required = obj.required.filter((r): r is string => typeof r === "string")
  }

  return { properties, required }
}
