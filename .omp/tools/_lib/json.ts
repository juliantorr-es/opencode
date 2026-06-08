export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(v).sort()) {
        sorted[key] = (v as Record<string, unknown>)[key]
      }
      return sorted
    }
    return v
  })
}
