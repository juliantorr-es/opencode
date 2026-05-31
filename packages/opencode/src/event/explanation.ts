// ── "Why Did You Do That?" Explanation Engine ──────────────
//
// Traces through the EventStore ledger to reconstruct why a
// particular event happened. Effect-based, with in-memory caching
// so repeated lookups on the same eventId are free.

import { Context, Effect, Schema } from "effect"
import { EventStore } from "."

export class ExplanationError {
  readonly _tag = "ExplanationError"
  constructor(readonly reason: string, readonly cause?: unknown) {}
}

export const ExplanationEventLink = Schema.Struct({
  id: Schema.String,
  eventType: Schema.String,
  actor: Schema.String,
  ts: Schema.String,
  toolName: Schema.optional(Schema.String),
  filePath: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
})
export type ExplanationEventLink = Schema.Schema.Type<typeof ExplanationEventLink>

export const ExplanationRisk = Schema.Literal("low", "medium", "high")
export type ExplanationRisk = Schema.Schema.Type<typeof ExplanationRisk>

export const Explanation = Schema.Struct({
  eventId: Schema.String,
  eventType: Schema.String,
  actor: Schema.String,
  ts: Schema.String,
  what: Schema.String,
  whyThisFile: Schema.optional(Schema.String),
  whichPrompt: Schema.optional(Schema.String),
  whichTool: Schema.optional(Schema.String),
  evidence: Schema.Array(Schema.String),
  testCoverage: Schema.optional(Schema.String),
  risk: ExplanationRisk,
  parentChain: Schema.Array(ExplanationEventLink),
  siblings: Schema.Array(ExplanationEventLink),
  children: Schema.Array(ExplanationEventLink),
})
export type Explanation = Schema.Schema.Type<typeof Explanation>

// ── Cache ──────────────────────────────────────────────────

const CACHE_TTL = 300_000
const CACHE_MAX = 500
const cache = new Map<string, { value: Explanation; ts: number }>()

// ── Helpers ────────────────────────────────────────────────

function summarizeEvent(event: { eventType: string; toolName?: string; filePath?: string }): string {
  if (event.filePath) return `${event.eventType} on ${event.filePath}`
  if (event.toolName) return `${event.eventType} via ${event.toolName}`
  return event.eventType
}

function toEventLink(event: {
  id: string
  eventType: string
  actor: string
  ts: string
  toolName?: string
  filePath?: string
  status?: string
}): ExplanationEventLink {
  return {
    id: event.id,
    eventType: event.eventType,
    actor: event.actor,
    ts: event.ts,
    toolName: event.toolName,
    filePath: event.filePath,
    status: event.status,
    summary: summarizeEvent(event),
  }
}

function inferRisk(events: Array<{ status?: string; errorCode?: string; eventType?: string }>): ExplanationRisk {
  if (events.some((e) => e.status === "failed" || e.errorCode)) return "high"
  if (events.some((e) => e.status === "denied" || e.eventType?.includes("denied"))) return "medium"
  return "low"
}

function extractFiles(events: Array<{ filePath?: string }>): string[] {
  return events
    .map((e) => e.filePath)
    .filter((f): f is string => f !== null && f !== undefined && f.length > 0)
}

function hasTestType(eventType: string): boolean {
  return (
    eventType.includes("test") ||
    eventType.includes("spec") ||
    eventType.includes("assert") ||
    eventType.includes("validate")
  )
}

// ── Public API ─────────────────────────────────────────────

export function explainEvent(
  eventId: string,
  sessionId: string,
): Effect.Effect<Explanation, ExplanationError, EventStore.Service> {
  return Effect.fn("explainEvent")(function* () {
    // Check cache first
    const cached = cache.get(`${sessionId}:${eventId}`)
    if (cached) {
      if (Date.now() - cached.ts < CACHE_TTL) return cached.value
      cache.delete(`${sessionId}:${eventId}`)
    }

    const store = yield* EventStore.Service

    // 1. Fetch the target event
    const events = yield* store.query({ parentEventId: eventId, limit: 1 })
    const targetEvents = yield* store.query({ id: eventId, limit: 1 })
    // Actually query by event id isn't directly supported by the store - we need to find it differently
    // Let's query all events with this id
    
    // Re-query: the store doesn't have a direct "get by id" filter. We need to
    // query by parentEventId to find children, and query broadly to find the event itself.
    // The simplest approach: query session events and filter.
    
    // Get the event by querying with generic filters and filtering client-side
    const allEvents = yield* store.query({ limit: 100 })
    const event = allEvents.find((e) => e.id === eventId)
    if (!event) {
      return yield* Effect.fail(new ExplanationError(`Event ${eventId} not found`))
    }

    // 2. Build parent chain (follow parentEventId up)
    const parentChain: ExplanationEventLink[] = []
    let currentParentId = event.parentEventId
    while (currentParentId) {
      const parent = allEvents.find((e) => e.id === currentParentId)
      if (!parent) break
      parentChain.push(toEventLink(parent))
      currentParentId = parent.parentEventId
    }

    // 3. Find siblings (same parentEventId, different id)
    const siblings: ExplanationEventLink[] = event.parentEventId
      ? allEvents
          .filter((e) => e.parentEventId === event.parentEventId && e.id !== eventId && e.actor !== "lifecycle")
          .slice(0, 20)
          .map(toEventLink)
      : []

    // 4. Find children (events where parentEventId === eventId)
    const children: ExplanationEventLink[] = allEvents
      .filter((e) => e.parentEventId === eventId)
      .slice(0, 20)
      .map(toEventLink)

    // 5. Collect deeper children recursively (one more level for grandchildren)
    const childIds = children.map((c) => c.id)
    const grandchildren = allEvents
      .filter((e) => e.parentEventId && childIds.includes(e.parentEventId))
      .slice(0, 20)
      .map(toEventLink)

    // 6. Derive explanation fields
    const promptEvent = parentChain.find((p) => p.actor === "user" || p.eventType.includes("prompt"))
    const toolEvent = siblings.find((s) => s.actor === "tool") ?? children.find((c) => c.actor === "tool")
    const fileEvents = extractFiles([
      event,
      ...siblings.filter((s) => s.filePath),
      ...children.filter((c) => c.filePath),
    ])
    const testEvents = [...children, ...grandchildren].filter(
      (c) => hasTestType(c.eventType) || c.toolName?.includes("test"),
    )

    const evidence: string[] = []
    if (fileEvents.length > 0) {
      evidence.push(`Files involved: ${[...new Set(fileEvents)].join(", ")}`)
    }
    if (siblings.length > 0) {
      const siblingTools = siblings
        .filter((s) => s.toolName)
        .map((s) => s.toolName)
        .filter(Boolean)
      if (siblingTools.length > 0) {
        evidence.push(`Tools used in this turn: ${[...new Set(siblingTools as string[])].join(", ")}`)
      }
    }

    let whichPrompt: string | null = null
    if (promptEvent) {
      whichPrompt = promptEvent.eventType.replace(/^session\.next\./, "").replace(/^session\./, "")
    }

    let whyThisFile: string | null = null
    if (event.filePath) {
      const fileTool = siblings.find((s) => s.toolName === event.toolName)
      whyThisFile = fileTool
        ? `Tool ${fileTool.toolName} processed ${event.filePath} as part of ${event.eventType}`
        : `File ${event.filePath} was referenced in ${event.eventType}`
    }

    let whichTool: string | null = event.toolName ?? null

    let testCoverage: string | null = null
    if (testEvents.length > 0) {
      testCoverage = `${testEvents.length} test-related event${testEvents.length > 1 ? "s" : ""} found: ${testEvents.map((t) => t.eventType).join(", ")}`
    }

    const allRelevant = [event, ...allEvents.filter((e) => e.parentEventId === eventId || e.id === event.parentEventId)]
    const risk = inferRisk(allRelevant)

    const explanation: Explanation = {
      eventId: event.id,
      eventType: event.eventType,
      actor: event.actor,
      ts: event.ts,
      what: summarizeEvent(event),
      whyThisFile,
      whichPrompt,
      whichTool,
      evidence,
      testCoverage,
      risk,
      parentChain,
      siblings,
      children: [...children, ...grandchildren],
    }

    // Cache
    if (cache.size >= CACHE_MAX) {
      const oldest = Array.from(cache.entries()).reduce((a, b) => (a[1].ts < b[1].ts ? a : b))
      cache.delete(oldest[0])
    }
    cache.set(`${sessionId}:${eventId}`, { value: explanation, ts: Date.now() })

    return explanation
  })
}

/**
 * Clear the in-memory explanation cache.
 * Useful when new events arrive and cached explanations may be stale.
 *
 * @deprecated No callers found in codebase. Remove if still unused after next audit.
 */
export function clearExplanationCache(): Effect.Effect<void> {
  return Effect.sync(() => cache.clear())
}

/**
 * Invalidate a single cached explanation.
 *
 * @deprecated No callers found in codebase. Remove if still unused after next audit.
 */
export function invalidateExplanation(eventId: string): Effect.Effect<void> {
  return Effect.sync(() => cache.delete(eventId))
}
