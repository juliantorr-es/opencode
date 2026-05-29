import { MessageID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { collectFailures, formatFailureReport } from "./failure-tools"

export type CheckpointRecord = {
  id: string
  sessionID: string
  messageID: string
  title: string
  published: boolean
  time: number
  failures: ReturnType<typeof collectFailures>
  report: string
}

export function createCheckpointRecord(input: {
  sessionID: string
  messageID: string
  title?: string
  messages: MessageV2.WithParts[]
  published?: boolean
}) {
  const failures = collectFailures(input.messages)
  const report = formatFailureReport(failures)
  return {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    messageID: input.messageID,
    title: input.title?.trim() || "Checkpoint",
    published: input.published ?? false,
    time: Date.now(),
    failures,
    report,
  } satisfies CheckpointRecord
}

export function formatCheckpointRecord(record: CheckpointRecord) {
  return [
    `${record.title} (${record.id})`,
    `Session: ${record.sessionID}`,
    `Message: ${record.messageID}`,
    `Published: ${record.published ? "yes" : "no"}`,
    "",
    record.report,
  ].join("\n")
}
