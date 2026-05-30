// ── Agent-Facing Event History Query Tools ──────────────────
//
// Effect service and tool definitions for querying runtime event
// history. Each query method reads from the EventStore and returns
// structured results that agents can use for resumability, debugging,
// and session awareness.
//
// These are registered as built-in tools so agents can call them
// directly instead of reading chat history or scanning raw logs.

import { Context, Effect, Layer, Schema } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Tool from "../tool/tool"
import * as EventStore from "./event-store"
import type { RuntimeEvent } from "./runtime-event"

// ── Service Interface ─────────────────────────────────────

export interface Interface {
  readonly lastFailedTools: (sessionId: string, limit?: number) => Effect.Effect<readonly RuntimeEvent[]>
  readonly lastEditedFiles: (sessionId: string, limit?: number) => Effect.Effect<readonly RuntimeEvent[]>
  readonly lastPermissionDenials: (sessionId: string, limit?: number) => Effect.Effect<readonly RuntimeEvent[]>
  readonly lastPhaseTransitions: (sessionId: string) => Effect.Effect<readonly RuntimeEvent[]>
  readonly lastCheckpoint: (sessionId: string) => Effect.Effect<RuntimeEvent | null>
  readonly lastSuccessfulTestRun: (sessionId: string) => Effect.Effect<RuntimeEvent | null>
  readonly eventsForFile: (filePath: string, sessionId: string) => Effect.Effect<readonly RuntimeEvent[]>
  readonly eventsForErrorCode: (errorCode: string, sessionId: string) => Effect.Effect<readonly RuntimeEvent[]>
  readonly eventsSinceCheckpoint: (sessionId: string) => Effect.Effect<readonly RuntimeEvent[]>
}

// ── Service Tag ───────────────────────────────────────────

export class Service extends Context.Service<Service, Interface>()(
  "@opencode/EventAgentQueries",
) {}

export const use = serviceUse(Service)

// ── Shared Parameter Helper ───────────────────────────────

const Params = (extra: Record<string, Schema.Schema<string, string, any>>) =>
  Schema.Struct({
    sessionId: Schema.String.annotations({
      description: "Session ID to query events for",
    }),
    ...extra,
  })

// ── Implementation ────────────────────────────────────────

const PHASE_EVENT_TYPES = new Set([
  "phase_start",
  "phase_complete",
  "phase_transition",
])

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* EventStore.Service

    const lastFailedTools: Interface["lastFailedTools"] = (
      sessionId: string,
      limit = 10,
    ) =>
      store
        .query({ sessionId, status: "failed" as const, limit, order: "desc" as const })
        .pipe(Effect.catchAll(() => Effect.succeed([])))

    const lastEditedFiles: Interface["lastEditedFiles"] = (
      sessionId: string,
      limit = 10,
    ) =>
      store
        .query({ sessionId, limit, order: "desc" as const })
        .pipe(
          Effect.map((events) =>
            events.filter((e) => e.eventType.startsWith("file_")),
          ),
          Effect.catchAll(() => Effect.succeed([])),
        )

    const lastPermissionDenials: Interface["lastPermissionDenials"] = (
      sessionId: string,
      limit = 10,
    ) =>
      store
        .query({ sessionId, status: "denied" as const, limit, order: "desc" as const })
        .pipe(Effect.catchAll(() => Effect.succeed([])))

    const lastPhaseTransitions: Interface["lastPhaseTransitions"] = (
      sessionId: string,
    ) =>
      store
        .query({ sessionId, limit: 50, order: "desc" as const })
        .pipe(
          Effect.map((events) =>
            events.filter((e) => PHASE_EVENT_TYPES.has(e.eventType)),
          ),
          Effect.catchAll(() => Effect.succeed([])),
        )

    const lastCheckpoint: Interface["lastCheckpoint"] = (sessionId: string) =>
      store
        .query({ sessionId, limit: 20, order: "desc" as const })
        .pipe(
          Effect.map(
            (events) =>
              events.find((e) => e.eventType === "checkpoint") ?? null,
          ),
          Effect.catchAll(() => Effect.succeed(null)),
        )

    const lastSuccessfulTestRun: Interface["lastSuccessfulTestRun"] = (
      sessionId: string,
    ) =>
      store
        .query({ sessionId, limit: 20, order: "desc" as const })
        .pipe(
          Effect.map(
            (events) =>
              events.find(
                (e) =>
                  e.eventType === "test_run" && e.status === "succeeded",
              ) ?? null,
          ),
          Effect.catchAll(() => Effect.succeed(null)),
        )

    const eventsForFile: Interface["eventsForFile"] = (
      filePath: string,
      sessionId: string,
    ) =>
      store
        .query({ sessionId, limit: 100, order: "desc" as const })
        .pipe(
          Effect.map((events) =>
            events.filter(
              (e) =>
                e.filePath &&
                (e.filePath === filePath || e.filePath.includes(filePath)),
            ),
          ),
          Effect.catchAll(() => Effect.succeed([])),
        )

    const eventsForErrorCode: Interface["eventsForErrorCode"] = (
      errorCode: string,
      sessionId: string,
    ) =>
      store
        .query({ sessionId, limit: 100, order: "desc" as const })
        .pipe(
          Effect.map((events) =>
            events.filter((e) => e.errorCode === errorCode),
          ),
          Effect.catchAll(() => Effect.succeed([])),
        )

    const eventsSinceCheckpoint: Interface["eventsSinceCheckpoint"] = (
      sessionId: string,
    ) =>
      Effect.gen(function* () {
        const checkpoint = yield* lastCheckpoint(sessionId)
        if (!checkpoint) {
          return yield* store
            .query({ sessionId, limit: 200, order: "asc" as const })
            .pipe(Effect.catchAll(() => Effect.succeed([])))
        }
        return yield* store
          .query({
            sessionId,
            fromTs: checkpoint.ts,
            limit: 200,
            order: "asc" as const,
          })
          .pipe(Effect.catchAll(() => Effect.succeed([])))
      })

    return Service.of({
      lastFailedTools,
      lastEditedFiles,
      lastPermissionDenials,
      lastPhaseTransitions,
      lastCheckpoint,
      lastSuccessfulTestRun,
      eventsForFile,
      eventsForErrorCode,
      eventsSinceCheckpoint,
    })
  }),
)

// ── Tool: Query Last Failed Tools ────────────────────────

export const LastFailedToolsTool = Tool.define(
  "query_last_failed_tools",
  Effect.gen(function* () {
    const store = yield* Service
    const Parameters = Params({
      limit: Schema.optional(Schema.Number).annotate({
        description: "Max results (default 10)",
      }),
    })
    return {
      description:
        "Query the most recent tool failures for a session. " +
        "Returns tool events with status 'failed' — useful for debugging " +
        "what went wrong during a session without reading chat history.",
      parameters: Parameters,
      execute: (
        params: { sessionId: string; limit?: number },
        _ctx: Tool.Context,
      ) =>
        store.lastFailedTools(params.sessionId, params.limit).pipe(
          Effect.map((events) => formatEventList("Last Failed Tools", events)),
        ),
    }
  }),
)

// ── Tool: Query Last Edited Files ─────────────────────────

export const LastEditedFilesTool = Tool.define(
  "query_last_edited_files",
  Effect.gen(function* () {
    const store = yield* Service
    const Parameters = Params({
      limit: Schema.optional(Schema.Number).annotate({
        description: "Max results (default 10)",
      }),
    })
    return {
      description:
        "Query the most recent file-related events (reads, writes, edits, creates, deletes) " +
        "for a session. Shows what files the agent touched and when.",
      parameters: Parameters,
      execute: (
        params: { sessionId: string; limit?: number },
        _ctx: Tool.Context,
      ) =>
        store.lastEditedFiles(params.sessionId, params.limit).pipe(
          Effect.map((events) => formatEventList("Last Edited Files", events)),
        ),
    }
  }),
)

// ── Tool: Query Permission Denials ────────────────────────

export const PermissionDenialsTool = Tool.define(
  "query_permission_denials",
  Effect.gen(function* () {
    const store = yield* Service
    const Parameters = Params({
      limit: Schema.optional(Schema.Number).annotate({
        description: "Max results (default 10)",
      }),
    })
    return {
      description:
        "Query permission denial events for a session. " +
        "Returns events where tool execution was denied by the permission system. " +
        "Useful for understanding what the agent was blocked from doing.",
      parameters: Parameters,
      execute: (
        params: { sessionId: string; limit?: number },
        _ctx: Tool.Context,
      ) =>
        store.lastPermissionDenials(params.sessionId, params.limit).pipe(
          Effect.map((events) =>
            formatEventList("Permission Denials", events),
          ),
        ),
    }
  }),
)

// ── Tool: Query Phase Transitions ─────────────────────────

export const PhaseTransitionsTool = Tool.define(
  "query_phase_transitions",
  Effect.gen(function* () {
    const store = yield* Service
    const Parameters = Params({})
    return {
      description:
        "Query phase transitions for a session. " +
        "Returns phase start, complete, and transition events — useful for " +
        "understanding what wave or phase the session was in.",
      parameters: Parameters,
      execute: (params: { sessionId: string }, _ctx: Tool.Context) =>
        store.lastPhaseTransitions(params.sessionId).pipe(
          Effect.map((events) => formatEventList("Phase Transitions", events)),
        ),
    }
  }),
)

// ── Tool: Query Last Checkpoint ───────────────────────────

export const LastCheckpointTool = Tool.define(
  "query_last_checkpoint",
  Effect.gen(function* () {
    const store = yield* Service
    const Parameters = Params({})
    return {
      description:
        "Query the most recent checkpoint event for a session. " +
        "Returns the last checkpoint record or null if none exists. " +
        "Useful for resumability — knowing where the last checkpoint was.",
      parameters: Parameters,
      execute: (params: { sessionId: string }, _ctx: Tool.Context) =>
        store.lastCheckpoint(params.sessionId).pipe(
          Effect.map((event) => {
            if (!event) {
              return {
                title: "query_last_checkpoint",
                metadata: { found: false },
                output: JSON.stringify(
                  { status: "no_checkpoint", sessionId: params.sessionId },
                  null,
                  2,
                ),
              }
            }
            return {
              title: "query_last_checkpoint",
              metadata: { found: true, ts: event.ts },
              output: JSON.stringify(formatEvent(event), null, 2),
            }
          }),
        ),
    }
  }),
)

// ── Tool: Query Last Successful Test Run ──────────────────

export const SuccessfulTestTool = Tool.define(
  "query_last_successful_test",
  Effect.gen(function* () {
    const store = yield* Service
    const Parameters = Params({})
    return {
      description:
        "Query the most recent successful test run for a session. " +
        "Returns the last test_run event with status 'succeeded' or null.",
      parameters: Parameters,
      execute: (params: { sessionId: string }, _ctx: Tool.Context) =>
        store.lastSuccessfulTestRun(params.sessionId).pipe(
          Effect.map((event) => {
            if (!event) {
              return {
                title: "query_last_successful_test",
                metadata: { found: false },
                output: JSON.stringify(
                  {
                    status: "no_successful_test",
                    sessionId: params.sessionId,
                  },
                  null,
                  2,
                ),
              }
            }
            return {
              title: "query_last_successful_test",
              metadata: { found: true, ts: event.ts },
              output: JSON.stringify(formatEvent(event), null, 2),
            }
          }),
        ),
    }
  }),
)

// ── Tool: Query Events for File ───────────────────────────

export const EventsForFileTool = Tool.define(
  "query_events_for_file",
  Effect.gen(function* () {
    const store = yield* Service
    const Parameters = Schema.Struct({
      filePath: Schema.String.annotations({
        description: "File path to filter events by (partial match)",
      }),
      sessionId: Schema.String.annotations({
        description: "Session ID to query",
      }),
      limit: Schema.optional(Schema.Number).annotate({
        description: "Max results (default 20)",
      }),
    })
    return {
      description:
        "Query runtime events associated with a specific file path. " +
        "Returns events where filePath matches or contains the given path. " +
        "Useful for understanding what happened to a specific file during a session.",
      parameters: Parameters,
      execute: (
        params: { filePath: string; sessionId: string; limit?: number },
        _ctx: Tool.Context,
      ) =>
        store.eventsForFile(params.filePath, params.sessionId).pipe(
          Effect.map((events) => {
            const limited = params.limit
              ? events.slice(0, params.limit)
              : events.slice(0, 20)
            return formatEventList(`Events for ${params.filePath}`, limited)
          }),
        ),
    }
  }),
)

// ── Tool: Query Events for Error Code ─────────────────────

export const EventsForErrorCodeTool = Tool.define(
  "query_events_for_error",
  Effect.gen(function* () {
    const store = yield* Service
    const Parameters = Schema.Struct({
      errorCode: Schema.String.annotations({
        description: "Error code to filter events by (exact match)",
      }),
      sessionId: Schema.String.annotations({
        description: "Session ID to query",
      }),
      limit: Schema.optional(Schema.Number).annotate({
        description: "Max results (default 20)",
      }),
    })
    return {
      description:
        "Query runtime events with a specific error code. " +
        "Returns failed events matching the given error code. " +
        "Useful for clustering related failures across a session.",
      parameters: Parameters,
      execute: (
        params: { errorCode: string; sessionId: string; limit?: number },
        _ctx: Tool.Context,
      ) =>
        store.eventsForErrorCode(params.errorCode, params.sessionId).pipe(
          Effect.map((events) => {
            const limited = params.limit
              ? events.slice(0, params.limit)
              : events.slice(0, 20)
            return formatEventList(
              `Events with error code ${params.errorCode}`,
              limited,
            )
          }),
        ),
    }
  }),
)

// ── Tool: Query Events Since Checkpoint ───────────────────

export const EventsSinceCheckpointTool = Tool.define(
  "query_events_since_checkpoint",
  Effect.gen(function* () {
    const store = yield* Service
    const Parameters = Params({})
    return {
      description:
        "Query all events that occurred since the last checkpoint in a session. " +
        "If no checkpoint exists, returns all events for the session. " +
        "Useful for understanding what changed since the last save point.",
      parameters: Parameters,
      execute: (params: { sessionId: string }, _ctx: Tool.Context) =>
        store.eventsSinceCheckpoint(params.sessionId).pipe(
          Effect.map((events) =>
            formatEventList("Events Since Checkpoint", events),
          ),
        ),
    }
  }),
)

// ── Formatting Helpers ────────────────────────────────────

function formatEvent(
  event: RuntimeEvent,
): Record<string, unknown> {
  return {
    id: event.id,
    ts: event.ts,
    actor: event.actor,
    eventType: event.eventType,
    status: event.status ?? null,
    toolName: event.toolName ?? null,
    filePath: event.filePath ?? null,
    phase: event.phase ?? null,
    errorCode: event.errorCode ?? null,
    errorMessage: event.errorMessage ?? null,
    durationMs: event.durationMs ?? null,
    model: event.model ?? null,
    recoverable: event.recoverable ?? null,
  }
}

function formatEventList(
  title: string,
  events: readonly RuntimeEvent[],
): Tool.ExecuteResult {
  const formatted = events.map(formatEvent)
  return {
    title,
    metadata: {
      count: events.length,
      eventTypes: [...new Set(events.map((e) => e.eventType))],
    },
    output: JSON.stringify(
      {
        count: events.length,
        events: formatted,
      },
      null,
      2,
    ),
  }
}
