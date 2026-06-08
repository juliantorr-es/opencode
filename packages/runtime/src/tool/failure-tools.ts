import type { MessageV2 } from "@/session/message-v2"

export type FailureRecord = {
  tool: string
  callID: string
  error: string
  input: Record<string, unknown>
}

export function collectFailures(
  messages: MessageV2.WithParts[],
  filter?: { tool?: string; callID?: string },
) {
  const failures: FailureRecord[] = []

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "error") continue
      if (filter?.tool && part.tool !== filter.tool) continue
      if (filter?.callID && part.callID !== filter.callID) continue

      failures.push({
        tool: part.tool,
        callID: part.callID,
        error: part.state.error,
        input: part.state.input,
      })
    }
  }

  return failures
}

export function formatFailureReport(failures: FailureRecord[]) {
  if (!failures.length) return "No failed tool calls were found."

  const lines = [`Found ${failures.length} failed tool call${failures.length === 1 ? "" : "s"}.`]
  for (const failure of failures) {
    lines.push("")
    lines.push(`Tool: ${failure.tool}`)
    lines.push(`Call: ${failure.callID}`)
    lines.push(`Error: ${failure.error}`)
    lines.push(`Input: ${JSON.stringify(failure.input)}`)
  }
  return lines.join("\n")
}
