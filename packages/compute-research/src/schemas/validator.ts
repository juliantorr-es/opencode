export function validateProvenanceRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null
}
