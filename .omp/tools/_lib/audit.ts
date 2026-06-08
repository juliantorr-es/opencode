import { createHash } from "node:crypto"
import { mkdirSync, appendFileSync } from "node:fs"
import { dirname } from "node:path"
import type { OmpToolEventV1, OmpToolContextV1 } from "./types.js"

/**
 * Append an audit event to the JSONL file at ctx.paths.events_path.
 *
 * Computes `event_sha256` as the SHA-256 of the JSON line *without* the
 * `event_sha256` field, then writes the full event (with the hash included)
 * as a JSONL line. Creates parent directories if they don't exist.
 */
export function appendAuditEvent(ctx: OmpToolContextV1, event: OmpToolEventV1): void {
  // Derive hash over the event without event_sha256
  const { event_sha256: _unused, ...rest } = event
  const lineWithoutSha = JSON.stringify(rest)
  const eventSha256 = createHash("sha256").update(lineWithoutSha, "utf-8").digest("hex")

  // Stamp the hash onto the event
  event.event_sha256 = eventSha256

  // Append full event as one JSONL line
  const fullLine = JSON.stringify(event) + "\n"
  const eventsPath = ctx.paths.events_path

  mkdirSync(dirname(eventsPath), { recursive: true })
  appendFileSync(eventsPath, fullLine, "utf-8")
}
