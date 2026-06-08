// ── Push Record — Verifiable Push Audit Trail ─────────────────
//
// JSONL-persisted record of every push attempt, linking commit
// SHAs to lane binder digests with full gate-evaluation evidence.
// Records are stored under .rig/push-records/<campaignId>.jsonl.
// ──────────────────────────────────────────────────────────────

import { Context, Effect, Layer, Schema } from "effect"
import * as Log from "@tribunus/core/util/log"
import { promises as fs } from "node:fs"
import * as Path from "node:path"

const log = Log.create({ service: "push-record" })

// ── Push Record Types ───────────────────────────────────────

export interface GateEval {
  readonly gateName: string
  readonly passed: boolean
  readonly evidenceHash: string
  readonly timestamp: string
}

export interface PushRecord {
  readonly pushId: string
  readonly campaignId: string
  readonly laneId: string
  readonly boundary: string
  readonly claim: string
  readonly gates: readonly GateEval[]
  readonly evidenceHashes: readonly string[]
  readonly timestamp: string
  readonly status: PushStatus
}

export type PushStatus =
  | "initiated"
  | "gates_pending"
  | "gates_passed"
  | "gates_failed"
  | "published"
  | "blocked"

export interface CreatePushRecordInput {
  readonly campaignId: string
  readonly laneId: string
  readonly boundary: string
  readonly claim: string
  readonly evidenceHashes?: readonly string[]
  readonly gates?: readonly GateEval[]
}

// ── Errors ─────────────────────────────────────────────────

export class PushRecordError extends Schema.TaggedErrorClass<PushRecordError>()("PushRecordError", {
  pushId: Schema.String,
  message: Schema.String,
}) {}

// ── Push Record Service Interface ──────────────────────────

export interface Interface {
  readonly createRecord: (input: CreatePushRecordInput) => Effect.Effect<string>
  readonly appendRecord: (record: PushRecord) => Effect.Effect<void>
  readonly readRecords: (campaignId: string) => Effect.Effect<readonly PushRecord[], PushRecordError>
  readonly getRecord: (pushId: string) => Effect.Effect<PushRecord | null>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PushRecordService") {}

// ── Helpers ────────────────────────────────────────────────

function generatePushId(): string {
  return `push-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function recordsDir(): string {
  return ".rig/push-records"
}

function campaignPath(campaignId: string): string {
  return `${recordsDir()}/${campaignId}.jsonl`
}

function serializeRecord(record: PushRecord): string {
  return JSON.stringify(record) + "\n"
}

function parseLine(line: string): PushRecord | null {
  try {
    return JSON.parse(line) as PushRecord
  } catch {
    return null
  }
}

async function ensureDir(): Promise<void> {
  const dir = recordsDir()
  await fs.mkdir(dir, { recursive: true })
}

// ── Layer ──────────────────────────────────────────────────

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.sync(() => {
    // In-memory index for fast getRecord lookups
    const recordsByPushId = new Map<string, PushRecord>()

    const createRecord = Effect.fn("PushRecord.createRecord")(
      function* (input: CreatePushRecordInput) {
        yield* Effect.promise(() => ensureDir())

        const pushId = generatePushId()
        const now = new Date().toISOString()

        const record: PushRecord = {
          pushId,
          campaignId: input.campaignId,
          laneId: input.laneId,
          boundary: input.boundary,
          claim: input.claim,
          gates: input.gates ?? [],
          evidenceHashes: input.evidenceHashes ?? [],
          timestamp: now,
          status: "initiated",
        }

        recordsByPushId.set(pushId, record)

        const path = campaignPath(input.campaignId)
        yield* Effect.promise(() => fs.appendFile(path, serializeRecord(record)))

        log.info("push record created", { pushId, campaignId: input.campaignId })
        return pushId
      },
    )

    const appendRecord = Effect.fn("PushRecord.appendRecord")(
      function* (record: PushRecord) {
        yield* Effect.promise(() => ensureDir())

        recordsByPushId.set(record.pushId, record)

        const path = campaignPath(record.campaignId)
        yield* Effect.promise(() => fs.appendFile(path, serializeRecord(record)))

        log.info("push record appended", { pushId: record.pushId, status: record.status })
      },
    )

    const readRecords = Effect.fn("PushRecord.readRecords")(
      function* (campaignId: string) {
        const path = campaignPath(campaignId)
        const exists = yield* Effect.promise(() =>
          fs.access(path).then(() => true).catch(() => false),
        )
        if (!exists) return [] as readonly PushRecord[]

        const content = yield* Effect.promise(() => fs.readFile(path, "utf-8"))
        const lines = content.split("\n").filter(Boolean)
        const records: PushRecord[] = []
        for (const line of lines) {
          const parsed = parseLine(line)
          if (parsed) records.push(parsed)
        }

        return records as readonly PushRecord[]
      },
    )

    const getRecord = Effect.fn("PushRecord.getRecord")(
      function* (pushId: string) {
        const cached = recordsByPushId.get(pushId)
        if (cached) return cached

        // Fallback: scan known .jsonl files in the records directory
        const dir = recordsDir()
        const dirExists = yield* Effect.promise(() =>
          fs.access(dir).then(() => true).catch(() => false),
        )
        if (!dirExists) return null

        const entries = yield* Effect.promise(() => fs.readdir(dir))
        for (const entry of entries) {
          if (!entry.endsWith(".jsonl")) continue
          const content = yield* Effect.promise(() =>
            fs.readFile(Path.join(dir, entry), "utf-8"),
          )
          for (const line of content.split("\n").filter(Boolean)) {
            const parsed = parseLine(line)
            if (parsed?.pushId === pushId) {
              recordsByPushId.set(pushId, parsed)
              return parsed
            }
          }
        }

        return null as PushRecord | null
      },
    )

    return Service.of({
      createRecord,
      appendRecord,
      readRecords,
      getRecord,
    })
  }),
)

export * as PushRecord from "."
