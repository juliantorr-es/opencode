export type JsonFactV1 = {
  kind: "tool_manifest" | "mcp_manifest" | "package" | "generic_json"
  name: string
  raw: Record<string, unknown>
}

export function parseJsonFacts(path: string, raw: Record<string, unknown>): JsonFactV1 {
  if (path.startsWith(".omp/tools/manifests/")) {
    return { kind: "tool_manifest", name: String(raw.tool_id ?? raw.name ?? path), raw }
  }
  if (path === ".omp/mcp-manifest.v1.json") {
    return { kind: "mcp_manifest", name: "mcp_manifest", raw }
  }
  if (path.endsWith("package.json")) {
    return { kind: "package", name: String(raw.name ?? path), raw }
  }
  return { kind: "generic_json", name: String(raw.name ?? path), raw }
}
