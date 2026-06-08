import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./read-messages.txt"

const Parameters = Schema.Struct({
  recipient: Schema.String.annotate({
    description:
      "Session ID or 'broadcast' to read messages for",
  }),
  type: Schema.optional(Schema.String).annotate({
    description:
      "DEPRECATED: use kind. Filter by message type (directive, handoff, clarification, result, broadcast)",
  }),
  session_id: Schema.optional(Schema.String).annotate({
    description: "Filter by session ID field",
  }),
  sender: Schema.optional(Schema.String).annotate({
    description: "Filter by sender field",
  }),
  kind: Schema.optional(Schema.String).annotate({
    description:
      "Filter by message kind (directive, handoff, clarification, result, broadcast, heartbeat)",
  }),
  wave: Schema.optional(Schema.String).annotate({
    description: "Filter by wave field",
  }),
  since: Schema.optional(Schema.String).annotate({
    description:
      "ISO timestamp — only messages after this time",
  }),
  until: Schema.optional(Schema.String).annotate({
    description:
      "ISO timestamp — only messages before this time",
  }),
  unread_only: Schema.optional(Schema.Boolean).annotate({
    description:
      "Only return messages newer than your last read_messages call",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description:
      "Maximum messages to return (default 50, max 200)",
  }),
})

/**
 * Parse a sent_at or timestamp field into a millisecond epoch for
 * time-range filtering.  Returns Infinity when the value is missing or
 * unparseable so the message passes through unless explicitly excluded.
 */
function parseMsgTime(
  msg: Record<string, unknown>,
): number {
  const raw = msg.sent_at ?? msg.timestamp
  if (raw == null) return Infinity
  if (typeof raw === "number") return raw
  if (typeof raw === "string") {
    const ms = Date.parse(raw)
    return isNaN(ms) ? Infinity : ms
  }
  return Infinity
}

export const ReadMessagesTool = Tool.define(
  "read_messages",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const messagesDir = path.join(instance.directory, ".rig", "messages")
          const ledgerFile = `${messagesDir}/${params.recipient}.jsonl`
          const readStateFile = `${messagesDir}/.read_state.json`
          const heartbeatFile = `${messagesDir}/${String(ctx.sessionID)}.jsonl`
          const maxMessages = Math.min(
            Math.max(params.limit ?? 50, 1),
            200,
          )

          // Resolve effective kind filter: kind overrides backward-compat type
          const kindFilter = params.kind ?? params.type ?? null

          // ── Read last-read state ──────────────────────────────────
          let lastRead: string | null = null
          const existingReadState = yield* fs.readFileStringSafe(readStateFile)
          if (existingReadState) {
            try {
              const state = JSON.parse(existingReadState)
              lastRead = state[String(ctx.agent)] ?? null
            } catch {
              /* start fresh if file is corrupt */
            }
          }

          // ── Read and filter messages ──────────────────────────────
          const exists = yield* fs.existsSafe(ledgerFile)
          let total = 0
          let returned = 0
          let output = `No messages found for ${params.recipient}`
          let lines: string[] = []
          let unreadCount = 0

          if (exists) {
            const content = yield* fs.readFileString(ledgerFile)
            lines = content.trim().split("\n").filter(Boolean)

            const messages: Array<Record<string, unknown>> = []
            for (const line of lines) {
              try {
                const msg = JSON.parse(line)

                // Kind/type filter (check both fields)
                if (kindFilter) {
                  const msgKind = msg.kind ?? msg.type
                  if (msgKind !== kindFilter) continue
                }

                // Session ID filter
                if (
                  params.session_id &&
                  msg.session_id !== params.session_id
                ) continue

                // Sender filter
                if (params.sender && msg.sender !== params.sender) continue

                // Wave filter
                if (params.wave && msg.wave !== params.wave) continue

                // Time range filters
                const ts = parseMsgTime(msg)
                if (params.since && ts < Date.parse(params.since)) continue
                if (params.until && ts > Date.parse(params.until)) continue

                // Unread-only filter
                if (params.unread_only && lastRead) {
                  const lastReadTs = Date.parse(lastRead)
                  if (!isNaN(lastReadTs) && ts <= lastReadTs) continue
                }

                messages.push(msg)
              } catch {
                // Skip malformed lines
              }
            }

            total = messages.length
            const selected = messages.slice(-maxMessages)
            returned = selected.length

            // ── Compute unread count from full buffer ─────────────
            if (lastRead) {
              const lastReadTs = Date.parse(lastRead)
              if (!isNaN(lastReadTs)) {
                // Unread is any non-heartbeat message newer than lastRead
                // We compute it from allMessages (which includes heartbeats
                // from every file read), but only count non-heartbeat.
                // For per-file reading, we only have lines from this file.
                for (const line of lines) {
                  try {
                    const umsg = JSON.parse(line)
                    if (umsg.kind === "heartbeat") continue
                    const uts = parseMsgTime(umsg)
                    if (uts > lastReadTs) unreadCount++
                  } catch { /* skip */ }
                }
              }
            }

            // ── Build structured response ─────────────────────────
            const result = {
              messages: selected as Array<Record<string, unknown>>,
              count: selected.length,
              total_in_buffer: lines.length,
              unread: unreadCount,
              last_read: lastRead,
              caller: ctx.agent,
            }
            output = JSON.stringify(result, null, 2)
          }

          // ── Register heartbeat ────────────────────────────────────
          const now = new Date()
          const heartbeat = {
            schema_version: "v1",
            message_id: `${now
              .toISOString()
              .replace(/[:.]/g, "")}_heartbeat`,
            session_id: String(ctx.sessionID),
            sender: String(ctx.agent),
            recipient: "*",
            kind: "heartbeat",
            subject: `${ctx.agent} active`,
            body: "",
            sent_at: now.toISOString(),
          }
          yield* fs.ensureDir(messagesDir)
          yield* fs.appendLine(heartbeatFile, JSON.stringify(heartbeat))

          // ── Update read state ─────────────────────────────────────
          const readState: Record<string, string> = {}
          if (existingReadState) {
            try {
              Object.assign(readState, JSON.parse(existingReadState))
            } catch { /* start fresh */ }
          }
          readState[String(ctx.agent)] = now.toISOString()
          yield* fs.writeJson(readStateFile, readState)

          return {
            title: "read_messages",
            metadata: {
              recipient: params.recipient,
              total,
              returned,
              total_in_buffer: lines.length,
              unread: unreadCount,
              ...(lastRead ? { last_read: lastRead } : {}),
              caller: ctx.agent,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ReadMessages from "./read-messages"
