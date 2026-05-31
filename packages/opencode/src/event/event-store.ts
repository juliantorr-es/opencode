import { Context, Effect, Layer } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { DatabaseAdapter } from "../storage/adapter"
import { RuntimeEventTable } from "@/storage/schema"
import { eq, and, asc, desc, gte, lte } from "drizzle-orm"
import type { RuntimeEvent } from "./runtime-event"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "event-store" })

export interface QueryFilters {
  sessionId?: string
  runId?: string
  eventType?: string
  actor?: string
  status?: string
  parentEventId?: string
  fromTs?: string
  toTs?: string
  toolName?: string
  laneId?: string
  limit?: number
  offset?: number
  order?: "asc" | "desc"
}

export interface Interface {
  readonly record: (event: RuntimeEvent) => Effect.Effect<void>
  readonly query: (filters?: QueryFilters) => Effect.Effect<RuntimeEvent[], DatabaseAdapter.DatabaseError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/EventStore") {}

export const use = serviceUse(Service)

function encodeForDb(event: RuntimeEvent) {
  return {
    id: event.id,
    session_id: event.sessionId,
    run_id: event.runId,
    parent_event_id: event.parentEventId ?? null,
    correlation_id: event.correlationId ?? null,
    ts: event.ts,
    actor: event.actor,
    event_type: event.eventType,
    phase: event.phase ?? null,
    status: event.status ?? null,
    tool_name: event.toolName ?? null,
    file_path: event.filePath ?? null,
    model: event.model ?? null,
    duration_ms: event.durationMs ?? null,
    token_input: event.tokenInput ?? null,
    token_output: event.tokenOutput ?? null,
    error_code: event.errorCode ?? null,
    error_message: event.errorMessage ?? null,
    recoverable: event.recoverable ?? null,
    payload_json: event.payloadJson ?? null,
    campaign_id: event.campaignId ?? null,
    lane_id: event.laneId ?? null,
    role: event.role ?? null,
  }
}

function decodeFromDb(row: Record<string, unknown>): RuntimeEvent {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    runId: row.run_id as string,
    parentEventId: (row.parent_event_id as string) ?? undefined,
    correlationId: (row.correlation_id as string) ?? undefined,
    ts: row.ts as string,
    actor: row.actor as RuntimeEvent["actor"],
    eventType: row.event_type as string,
    phase: (row.phase as string) ?? undefined,
    status: (row.status as RuntimeEvent["status"]) ?? undefined,
    toolName: (row.tool_name as string) ?? undefined,
    filePath: (row.file_path as string) ?? undefined,
    model: (row.model as string) ?? undefined,
    durationMs: (row.duration_ms as number) ?? undefined,
    tokenInput: (row.token_input as number) ?? undefined,
    tokenOutput: (row.token_output as number) ?? undefined,
    errorCode: (row.error_code as string) ?? undefined,
    errorMessage: (row.error_message as string) ?? undefined,
    recoverable: (row.recoverable as boolean) ?? undefined,
    payloadJson: (row.payload_json as Record<string, unknown>) ?? undefined,
    campaignId: (row.campaign_id as string) ?? undefined,
    laneId: (row.lane_id as string) ?? undefined,
    role: (row.role as string) ?? undefined,
  }
}

function buildWhere(filters: QueryFilters) {
  const conditions: ReturnType<typeof eq>[] = []

  if (filters.sessionId) conditions.push(eq(RuntimeEventTable.session_id, filters.sessionId))
  if (filters.runId) conditions.push(eq(RuntimeEventTable.run_id, filters.runId))
  if (filters.eventType) conditions.push(eq(RuntimeEventTable.event_type, filters.eventType))
  if (filters.actor) conditions.push(eq(RuntimeEventTable.actor, filters.actor))
  if (filters.status) conditions.push(eq(RuntimeEventTable.status, filters.status))
  if (filters.parentEventId) conditions.push(eq(RuntimeEventTable.parent_event_id, filters.parentEventId))
  if (filters.fromTs) conditions.push(gte(RuntimeEventTable.ts, filters.fromTs))
  if (filters.toTs) conditions.push(lte(RuntimeEventTable.ts, filters.toTs))
  if (filters.toolName) conditions.push(eq(RuntimeEventTable.tool_name, filters.toolName))
  if (filters.laneId) conditions.push(eq(RuntimeEventTable.lane_id, filters.laneId))

  return conditions.length > 0 ? and(...conditions) : undefined
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const adapter = yield* DatabaseAdapter.Service

    const record = Effect.fn("EventStore.record")(function* (event: RuntimeEvent) {
      const encoded = encodeForDb(event)
      yield* adapter.query((db) => db.insert(RuntimeEventTable).values(encoded).execute())
      log.info("recorded", { id: event.id, type: event.eventType })
    })

    const query = Effect.fn("EventStore.query")(function* (filters?: QueryFilters) {
      const where = filters ? buildWhere(filters) : undefined
      const orderFn = filters?.order === "asc" ? asc : desc
      const limit = filters?.limit ?? 100
      const offset = filters?.offset ?? 0

      const rows = yield* adapter.query((db) => {
        let q = db.select().from(RuntimeEventTable)
        if (where) q = q.where(where)
        q = q.orderBy(orderFn(RuntimeEventTable.ts))
        q = q.limit(limit).offset(offset)
        return q.execute() as Promise<Record<string, unknown>[]>
      })

      return rows.map(decodeFromDb)
    })

    return Service.of({ record, query } as Interface)
  }),
)
