import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { MessageID } from "@/session/schema"
import DESCRIPTION from "./send-message.txt"

const MessageType = Schema.Union([
  Schema.Literal("directive"),
  Schema.Literal("handoff"),
  Schema.Literal("clarification"),
  Schema.Literal("result"),
  Schema.Literal("broadcast"),
])

const MessageKind = Schema.Literals([
  "directive",
  "blocker",
  "clarification",
  "handoff",
  "wave_start",
  "wave_complete",
])

const RECIPIENT_PATTERN = /^[a-zA-Z0-9._@-]+$/

const Parameters = Schema.Struct({
  recipient: Schema.String.annotate({
    description: "Target agent name, or '*' for broadcast",
  }),
  type: MessageType.annotate({
    description: "Message type: directive, handoff, clarification, result, or broadcast",
  }),
  payload: Schema.String.annotate({
    description:
      "JSON payload content of the message (used as body when `body` is not provided)",
  }),
  kind: Schema.optional(MessageKind).annotate({
    description:
      "Message kind: directive, blocker, clarification, handoff, wave_start, wave_complete (overrides type when provided)",
  }),
  wave: Schema.optional(Schema.String).annotate({
    description: "Current wave name",
  }),
  subject: Schema.optional(Schema.String).annotate({
    description: "Message subject line",
  }),
  body: Schema.optional(Schema.String).annotate({
    description:
      "Message body text (overrides payload when provided)",
  }),
  dry_run: Schema.optional(Schema.Boolean).annotate({
    description: "Preview the message without writing to the ledger",
  }),
})

const MAX_PAYLOAD_BYTES = 100 * 1024 // 100KB

/**
 * Draw a Unicode box frame around content lines.
 *
 *   ┌─────────────────────────┐
 *   │ ✉  kind → recipient     │
 *   │ subject: subj            │
 *   │ status:  delivered       │
 *   │ id: msgID                │
 *   └─────────────────────────┘
 */
function formatBox(lines: readonly string[]): string {
  const innerWidth = Math.max(...lines.map((l) => l.length), 40)
  const pad = (s: string) => " " + s + " ".repeat(innerWidth - s.length - 1)
  const top = "┌" + "─".repeat(innerWidth) + "┐"
  const bottom = "└" + "─".repeat(innerWidth) + "┘"
  const body = lines.map((l) => "│" + pad(l) + "│").join("\n")
  return top + "\n" + body + "\n" + bottom
}

export const SendMessageTool = Tool.define(
  "send_message",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          // Resolve kind: provided kind overrides type for forward compat
          const effectiveKind = params.kind ?? params.type

          // Resolve body: provided body text overrides JSON payload
          const effectiveBody = params.body ?? params.payload

          if (effectiveBody.length > MAX_PAYLOAD_BYTES) {
            throw new Error(
              `Body/payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
            )
          }

          // Allowlist-based recipient validation — rejects ../, /, \\0 all
          // non-allowlist characters (only a-zA-Z0-9._@- are permitted)
          if (!RECIPIENT_PATTERN.test(params.recipient)) {
            throw new Error(
              `Invalid recipient "${params.recipient}". ` +
                `Recipient must match pattern /^[a-zA-Z0-9._@-]+$/ — ` +
                `only letters, digits, dots, underscores, @, and hyphens are allowed.`,
            )
          }

          const instance = yield* InstanceState.context
          const messagesDir = instance.directory + "/.rig/messages"
          const messageID = MessageID.ascending()

          // Attempt JSON parse for structured body/payload
          let parsedBody: unknown
          try {
            parsedBody = JSON.parse(effectiveBody)
          } catch {
            parsedBody = effectiveBody
          }

          // ── Dry-run: preview without writing ──
          if (params.dry_run) {
            const preview =
              effectiveBody.length > 80
                ? effectiveBody.slice(0, 80) + "..."
                : effectiveBody

            return {
              title: `send_message:${effectiveKind} (dry-run)`,
              metadata: {
                messageID,
                recipient: params.recipient,
                kind: effectiveKind,
                dryRun: true,
              },
              output: formatBox([
                `🔍 DRY RUN`,
                `✉  ${effectiveKind} → ${params.recipient}`,
                `subject: ${params.subject ?? "(no subject)"}`,
                `body: ${preview}`,
                `note: No message written. Remove dry_run=true to send.`,
              ]),
            }
          }

          // ── Build message record ──
          const message = {
            id: messageID,
            session_id: instance.directory,
            sender: effectiveKind,
            recipient: params.recipient,
            type: params.type, // kept for backward compat with read_messages
            kind: effectiveKind,
            wave: params.wave ?? null,
            subject: params.subject ?? null,
            body: parsedBody,
            payload: parsedBody, // kept for backward compat
            timestamp: Date.now(),
          }

          // ── Append to JSONL ──
          const ledgerFile = `${messagesDir}/${params.recipient}.jsonl`
          const messageLine = JSON.stringify(message) + "\n"

          yield* fs.ensureDir(messagesDir)
          yield* fs.writeFileString(ledgerFile, messageLine, { flag: "a" })

          // ── Formatted box output ──
          const boxLines: string[] = [
            `✉  ${effectiveKind} → ${params.recipient}`,
          ]
          if (params.subject) {
            boxLines.push(`subject: ${params.subject}`)
          }
          if (params.wave) {
            boxLines.push(`wave: ${params.wave}`)
          }
          boxLines.push(`status: delivered`, `id: ${messageID}`)

          return {
            title: `send_message:${effectiveKind}`,
            metadata: {
              messageID,
              recipient: params.recipient,
              kind: effectiveKind,
            },
            output: formatBox(boxLines),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as SendMessage from "./send-message"
