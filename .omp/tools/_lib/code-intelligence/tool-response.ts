export function makeToolResponse(summary: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: summary }],
    details,
  }
}
