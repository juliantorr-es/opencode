// ── Agent-Facing Context Query Tools ───────────────────────
//
// 11 registered tools that let agents query session and project
// context without scraping the repo. Each tool validates its
// arguments via Effect Schema and returns structured JSON.
//
// Wraps: Authority, FileMemory, ProjectMap, EventAgentQueries,
// EventStore, Scratchpad, ContextInvalidationBus.

import { Effect, Schema } from "effect"
import { Tool } from "@/tool/tool"
import { Authority, Scratchpad } from "@/agent"
import { EventStore, EventAgentQueries } from "@/event"
import * as FileMemory from "./file-memory"
import * as ProjectMap from "./project-map"
import { ContextInvalidationBus } from "./invalidation-bus"
import type { InvalidationScope } from "./invalidation-registry"

// ── Shared helpers ────────────────────────────────────────

function formatResult(
  title: string,
  data: unknown,
  metadata?: Record<string, unknown>,
): Tool.ExecuteResult {
  return {
    title,
    metadata: metadata ?? {},
    output: JSON.stringify(data, null, 2),
  }
}

function formatEventBrief(e: {
  readonly id: string
  readonly eventType: string
  readonly actor: string
  readonly ts: string
  readonly status?: string | undefined
  readonly toolName?: string | undefined
  readonly filePath?: string | undefined
  readonly errorCode?: string | undefined
  readonly errorMessage?: string | undefined
  readonly phase?: string | undefined
}) {
  return {
    id: e.id,
    event_type: e.eventType,
    actor: e.actor,
    ts: e.ts,
    status: e.status ?? null,
    tool: e.toolName ?? null,
    file: e.filePath ?? null,
    error_code: e.errorCode ?? null,
    error_message: e.errorMessage?.slice(0, 300) ?? null,
  }
}

function formatFileContext(e: {
  path: string
  digest: string
  lastReadAt: number
  lastEditedAt?: number
  lastEditor?: string
  lastEditTool?: string
  lineCount: number
  language: string
  symbols: string[]
  imports: string[]
  exports: string[]
  knownTests: string[]
  riskTags: string[]
  isGenerated: boolean
  isProtected: boolean
}) {
  return {
    path: e.path,
    digest: e.digest,
    last_read_at: new Date(e.lastReadAt).toISOString(),
    last_edited_at: e.lastEditedAt ? new Date(e.lastEditedAt).toISOString() : null,
    last_editor: e.lastEditor ?? null,
    last_edit_tool: e.lastEditTool ?? null,
    line_count: e.lineCount,
    language: e.language,
    symbols: e.symbols,
    imports: e.imports,
    exports: e.exports,
    known_tests: e.knownTests,
    risk_tags: e.riskTags,
    is_generated: e.isGenerated,
    is_protected: e.isProtected,
  }
}

// ── Tool 1: get_operating_picture ────────────────────────

const GetOperatingPictureParameters = Schema.Struct({})

export const GetOperatingPictureTool = Tool.define(
  "get_operating_picture",
  Effect.gen(function* () {
    const authority = yield* Authority.Service
    const scratchpad = yield* Scratchpad.Service
    const fileMemory = yield* FileMemory.Service
    const queries = yield* EventAgentQueries.Service

    return {
      description:
        "Returns the current mission and run state — Authority contract, " +
        "Scratchpad state, working set summary, and recent events. One call " +
        "replaces multiple manual queries for agent orientation.",
      parameters: GetOperatingPictureParameters,
      execute: (_params: Record<string, never>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const contract = yield* authority.toContext()
          const pad = yield* scratchpad.get
          const allFiles = yield* fileMemory.getAll()
          const lastEvents = yield* queries.lastFailedTools(ctx.sessionID, 3)
          const lastCheckpoint = yield* queries.lastCheckpoint(ctx.sessionID)
          const workingSet = [...allFiles]
            .sort((a, b) => b.lastReadAt - a.lastReadAt)
            .slice(0, 5)
          return formatResult("Operating Picture", {
            session_id: ctx.sessionID,
            agent: ctx.agent,
            authority: contract,
            scratchpad: {
              hypothesis: pad.hypothesis,
              verified_facts: pad.verifiedFacts,
              uncertain: pad.uncertainFacts,
              files_inspected: pad.filesInspected,
              next_action: pad.nextAction,
              stop_condition: pad.stopCondition,
              risks: pad.risks,
            },
            working_set: workingSet.map((e) => ({
              path: e.path,
              language: e.language,
              last_read: new Date(e.lastReadAt).toISOString(),
              last_edited: e.lastEditedAt ? new Date(e.lastEditedAt).toISOString() : null,
              editor: e.lastEditor ?? null,
              line_count: e.lineCount,
              risk_tags: e.riskTags,
            })),
            recent_failures: lastEvents.length,
            has_checkpoint: lastCheckpoint !== null,
          })
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Tool 2: get_project_map ──────────────────────────────

const GetProjectMapParameters = Schema.Struct({})

export const GetProjectMapTool = Tool.define(
  "get_project_map",
  Effect.gen(function* () {
    const projectMap = yield* ProjectMap.Service

    return {
      description:
        "Returns the ProjectMap — package layout, entry points, " +
        "test directories, config files, and source paths. Agents use " +
        "this to understand project structure without filesystem traversal.",
      parameters: GetProjectMapParameters,
      execute: () =>
        Effect.gen(function* () {
          const map = yield* projectMap.get()
          return formatResult("Project Map", {
            packages: map.packages.map((p) => ({
              name: p.name,
              path: p.path,
              entrypoint: p.entrypoint ?? null,
              test_command: p.testCommand ?? null,
              build_command: p.buildCommand ?? null,
              dependencies: p.dependencies,
            })),
            config_files: map.configFiles,
            generated_dirs: map.generatedDirs,
          })
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Tool 3: get_working_set ──────────────────────────────

const GetWorkingSetParameters = Schema.Struct({
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max results (default 20)",
  }),
})

export const GetWorkingSetTool = Tool.define(
  "get_working_set",
  Effect.gen(function* () {
    const fileMemory = yield* FileMemory.Service

    return {
      description:
        "Returns recently touched files ranked by recency and relevance. " +
        "Helps agents understand what files are active in the current session " +
        "without scanning the full project. Sorted by last read time descending.",
      parameters: GetWorkingSetParameters,
      execute: (params: { limit?: number }) =>
        Effect.gen(function* () {
          const allFiles = yield* fileMemory.getAll()
          const sorted = [...allFiles]
            .sort((a, b) => b.lastReadAt - a.lastReadAt)
            .slice(0, params.limit ?? 20)
          return formatResult("Working Set", {
            count: sorted.length,
            files: sorted.map((e) => ({
              path: e.path,
              language: e.language,
              last_read: new Date(e.lastReadAt).toISOString(),
              last_edited: e.lastEditedAt ? new Date(e.lastEditedAt).toISOString() : null,
              editor: e.lastEditor ?? null,
              line_count: e.lineCount,
              risk_tags: e.riskTags,
              symbols: e.symbols.slice(0, 20),
            })),
          })
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Tool 4: get_file_context ────────────────────────────

const GetFileContextParameters = Schema.Struct({
  path: Schema.String.annotate({
    description: "File path to query context for",
  }),
})

export const GetFileContextTool = Tool.define(
  "get_file_context",
  Effect.gen(function* () {
    const fileMemory = yield* FileMemory.Service
    const queries = yield* EventAgentQueries.Service

    return {
      description:
        "Returns FileContext for a given path — summary, digest, symbols, " +
        "imports/exports, recent event history, and risk indicators. " +
        "Helps agents understand a file's role and recent activity without " +
        "reading the full source.",
      parameters: GetFileContextParameters,
      execute: (params: { path: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const maybeCtx = yield* fileMemory.get(params.path)
          const events = yield* queries.eventsForFile(params.path, ctx.sessionID)
          return formatResult("File Context", {
            found: maybeCtx._tag === "Some",
            file_context: maybeCtx._tag === "Some" ? formatFileContext(maybeCtx.value) : null,
            event_count: events.length,
            recent_events: events.slice(-5).map(formatEventBrief),
          })
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Tool 5: get_related_context ──────────────────────────

const GetRelatedContextParameters = Schema.Struct({
  target: Schema.String.annotate({
    description:
      "Target to find related context for — a file path, symbol name, " +
      "or error code. The tool tries each interpretation.",
  }),
})

export const GetRelatedContextTool = Tool.define(
  "get_related_context",
  Effect.gen(function* () {
    const queries = yield* EventAgentQueries.Service
    const fileMemory = yield* FileMemory.Service

    return {
      description:
        "Given a file path, symbol name, or error code, returns related " +
        "files, tests, events, and prior fixes from the EventStore. " +
        "Agents use this to discover what else is connected to a target " +
        "before making changes.",
      parameters: GetRelatedContextParameters,
      execute: (params: { target: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sessionId = ctx.sessionID
          const fileEvents = yield* queries.eventsForFile(params.target, sessionId)
          const errorEvents = yield* queries.eventsForErrorCode(params.target, sessionId)
          const editedFiles = yield* queries.lastEditedFiles(sessionId, 10)
          const searchResults = yield* fileMemory.search(params.target)
          const maybeCtx = yield* fileMemory.get(params.target)
          return formatResult("Related Context", {
            target: params.target,
            is_known_file: maybeCtx._tag === "Some",
            file_touch_count: maybeCtx._tag === "Some" ? 1 : 0,
            matching_files: searchResults,
            file_events: fileEvents.slice(-10).map(formatEventBrief),
            error_context: errorEvents.slice(-5).map(formatEventBrief),
            recently_edited_files: editedFiles.map(formatEventBrief),
            total_related_events: fileEvents.length + errorEvents.length,
          })
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Tool 6: query_event_history ─────────────────────────

const QueryEventHistoryParameters = Schema.Struct({
  session_id: Schema.optional(Schema.String).annotate({
    description: "Session ID to query (defaults to current session)",
  }),
  event_type: Schema.optional(Schema.String).annotate({
    description: "Filter by event type (e.g. 'session.next.tool.failed', 'file.edited')",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max results (default 20)",
  }),
  from_ts: Schema.optional(Schema.String).annotate({
    description: "ISO timestamp filter — only events at or after this time",
  }),
  to_ts: Schema.optional(Schema.String).annotate({
    description: "ISO timestamp filter — only events at or before this time",
  }),
})

export const QueryEventHistoryTool = Tool.define(
  "query_event_history",
  Effect.gen(function* () {
    const eventStore = yield* EventStore.Service

    return {
      description:
        "Wraps EventAgentQueries to return filtered recent events from the " +
        "EventStore. Supports filtering by event type, session, time window, " +
        "and result limit. Agents use this to inspect runtime history without " +
        "reading raw logs or chat history.",
      parameters: QueryEventHistoryParameters,
      execute: (
        params: {
          session_id?: string
          event_type?: string
          limit?: number
          from_ts?: string
          to_ts?: string
        },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          const events = yield* eventStore.query({
            sessionId: params.session_id ?? ctx.sessionID,
            eventType: params.event_type,
            limit: params.limit ?? 20,
            fromTs: params.from_ts,
            toTs: params.to_ts,
          })
          return formatResult(
            "Event History",
            {
              count: events.length,
              query: {
                session_id: params.session_id ?? ctx.sessionID,
                event_type: params.event_type ?? "all",
                limit: params.limit ?? 20,
              },
              events: events.map(formatEventBrief),
            },
            { count: events.length },
          )
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Tool 7: get_validation_context ──────────────────────

const GetValidationContextParameters = Schema.Struct({})

export const GetValidationContextTool = Tool.define(
  "get_validation_context",
  Effect.gen(function* () {
    const queries = yield* EventAgentQueries.Service

    return {
      description:
        "Returns validation state — last successful test run, recent failures, " +
        "and failing tools. Agents use this to decide whether changes are safe " +
        "to apply or if they need to fix broken state first.",
      parameters: GetValidationContextParameters,
      execute: (_params: Record<string, never>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sessionId = ctx.sessionID
          const lastTest = yield* queries.lastSuccessfulTestRun(sessionId)
          const failures = yield* queries.lastFailedTools(sessionId, 10)
          const editedFiles = yield* queries.lastEditedFiles(sessionId, 5)

          return formatResult("Validation Context", {
            session_id: sessionId,
            last_successful_test: lastTest ? formatEventBrief(lastTest) : null,
            recent_failures: failures.map(formatEventBrief),
            failure_count: failures.length,
            recently_edited: editedFiles.length,
            validation_clean: failures.length === 0,
          })
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Tool 8: get_claim_context ───────────────────────────

const GetClaimContextParameters = Schema.Struct({})

export const GetClaimContextTool = Tool.define(
  "get_claim_context",
  Effect.gen(function* () {
    const eventStore = yield* EventStore.Service

    return {
      description:
        "Returns current path reservations and conflicts from coordination " +
        "events. Queries the EventStore for coordination.path.claimed and " +
        "coordination.path.released events to build a picture of active claims.",
      parameters: GetClaimContextParameters,
      execute: (_params: Record<string, never>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const claims = yield* eventStore.query({
            eventType: "coordination.path.claimed",
            sessionId: ctx.sessionID,
            limit: 50,
          })
          const releases = yield* eventStore.query({
            eventType: "coordination.path.released",
            sessionId: ctx.sessionID,
            limit: 50,
          })
          const claimPaths = new Set(claims.map((e) => e.filePath).filter((p): p is string => !!p))
          const releasePaths = new Set(releases.map((e) => e.filePath).filter((p): p is string => !!p))
          const activePaths = [...claimPaths].filter((p) => !releasePaths.has(p))

          return formatResult("Claim Context", {
            session_id: ctx.sessionID,
            active_claims: activePaths,
            total_claims: claims.length,
            total_releases: releases.length,
            recent_claims: claims.slice(-5).map(formatEventBrief),
          })
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Tool 9: update_scratchpad ───────────────────────────

const UpdateScratchpadParameters = Schema.Struct({
  fields: Schema.String.annotate({
    description:
      "JSON object with partial Scratchpad fields to update. " +
      "Supported keys: hypothesis, verifiedFacts, uncertainFacts, " +
      "filesInspected, candidateFixes, risks, nextAction, stopCondition. " +
      "Example: '{\"hypothesis\":\"Cache miss in loader\",\"verifiedFacts\":[\"File exists\"]}'",
  }),
})

export const UpdateScratchpadTool = Tool.define(
  "update_scratchpad",
  Effect.gen(function* () {
    const scratchpad = yield* Scratchpad.Service

    return {
      description:
        "Updates the agent Scratchpad with verified facts, uncertainties, " +
        "or next actions. Stores structured reasoning state across agent " +
        "turns. Call this whenever you discover a fact, form a hypothesis, " +
        "or change your next planned action (AW-003).",
      parameters: UpdateScratchpadParameters,
      execute: (params: { fields: string }) =>
        Effect.gen(function* () {
          let updates: Record<string, unknown>
          try {
            updates = JSON.parse(params.fields) as Record<string, unknown>
          } catch {
            return formatResult("Update Scratchpad", {
              error: "Invalid JSON in fields parameter",
            })
          }

          yield* scratchpad.update(updates as Partial<Scratchpad.Scratchpad>)
          const state = yield* scratchpad.get
          return formatResult("Update Scratchpad", {
            status: "updated",
            scratchpad: {
              hypothesis: state.hypothesis,
              verified_facts: state.verifiedFacts,
              uncertain: state.uncertainFacts,
              files_inspected: state.filesInspected,
              candidate_fixes: state.candidateFixes,
              risks: state.risks,
              next_action: state.nextAction,
              stop_condition: state.stopCondition,
            },
          })
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Tool 10: mark_context_stale ─────────────────────────

const MarkContextStaleParameters = Schema.Struct({
  scope: Schema.String.annotate({
    description:
      "Invalidation scope to mark stale. One of: file_summary, " +
      "symbol_outline, module_summary, related_test_status, " +
      "working_set_ranking, checkpoint_readiness, " +
      "validation_clean_state, pr_readiness, hypothesis_confidence, " +
      "project_map, claims, dirty_file_state, file_digests, " +
      "plugin_capability_context, tool_registry_context, " +
      "event_projections, duckdb_views.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Optional file path that triggered the staleness",
  }),
})

export const MarkContextStaleTool = Tool.define(
  "mark_context_stale",
  Effect.gen(function* () {
    const bus = yield* ContextInvalidationBus

    return {
      description:
        "Marks a context scope as stale, triggering invalidation " +
        "notifications on the ContextInvalidationBus. Subscribers " +
        "will refresh their cached data for the affected scope. " +
        "Call this when the underlying data for a scope has changed.",
      parameters: MarkContextStaleParameters,
      execute: (
        params: { scope: string; path?: string },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          yield* bus.notify(params.scope as InvalidationScope, ctx.sessionID)
          return formatResult("Mark Context Stale", {
            status: "invalidated",
            scope: params.scope,
            session_id: ctx.sessionID,
            path: params.path ?? null,
          })
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Tool 11: request_context_refresh ─────────────────────

const RequestContextRefreshParameters = Schema.Struct({
  target: Schema.String.annotate({
    description:
      "Target context that needs refreshing — a file path, " +
      "symbol name, or scope name. Triggers a context.request_refresh " +
      "event on the invalidation bus.",
  }),
})

export const RequestContextRefreshTool = Tool.define(
  "request_context_refresh",
  Effect.gen(function* () {
    const bus = yield* ContextInvalidationBus

    return {
      description:
        "Triggers a context.request_refresh event on the invalidation bus. " +
        "Subscribers in the event_projections scope will re-read their " +
        "data sources. Use this when you know the cached context is stale " +
        "and need to force a refresh before the next action.",
      parameters: RequestContextRefreshParameters,
      execute: (params: { target: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* bus.notify("context.request_refresh", ctx.sessionID)
          return formatResult("Request Context Refresh", {
            status: "refresh_requested",
            target: params.target,
            session_id: ctx.sessionID,
            event: "context.request_refresh",
          })
        }).pipe(Effect.orDie),
    }
  }),
)
