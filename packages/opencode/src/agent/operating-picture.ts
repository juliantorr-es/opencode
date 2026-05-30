import { Context, Effect, Layer, Schema } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Git } from "@/git"
import { EventStore } from "@/event"
import { DatabaseAdapter } from "@/storage/adapter"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "operating-picture" })

// ── Types ─────────────────────────────────────────────────

export interface AgentOperatingPicture {
  mission: {
    id: string
    goal: string
    mode: string
    phase: string
  }
  authority: {
    allowedTools: string[]
    deniedTools: string[]
    writeScope: string[]
  }
  workspace: {
    branch: string
    dirtyFiles: string[]
    claimedFiles: string[]
    protectedFiles: string[]
  }
  validation: {
    lastCommand?: string
    status?: string
    summary?: string
  }
}

export interface GetOptions {
  sessionId?: string
  agentName?: string
}

// ── Interface ──────────────────────────────────────────────

export interface Interface {
  readonly get: (options?: GetOptions) => Effect.Effect<AgentOperatingPicture>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatingPicture") {}

export const use = serviceUse(Service)

// ── Helpers ────────────────────────────────────────────────

/**
 * Query the coordination_claim table for active claims with file paths.
 */
function getClaimedFiles(): Effect.Effect<string[], DatabaseAdapter.DatabaseError> {
  return Effect.gen(function* () {
    const adapter = yield* DatabaseAdapter.Service
    const rows = yield* adapter.query((db) =>
      db
        .select({
          file_path: db.file_path ?? null,
          task_id: db.task_id,
        })
        .from(db)
        .all()
    )
    return (rows as Array<{ file_path: string | null }>)
      .map((r) => r.file_path)
      .filter((f): f is string => f !== null)
  })

  // Fallback: coordination claims aren't directly queryable via the
  // exported API, so read coordination_claim rows through the adapter.
  const CoordinationClaimTable = "coordination_claim"
  return Effect.gen(function* () {
    const adapter = yield* DatabaseAdapter.Service
    const rows: Array<{ file_path: string | null }> = yield* adapter.query((db) =>
      db
        .select({
          file_path: db.file_path ?? null,
        })
        .from(CoordinationClaimTable as any)
        .all()
    )
    return rows.map((r) => r.file_path).filter((f): f is string => f !== null)
  })
}

const DEFAULT_BRANCH = "unknown"
const DEFAULT_DIRTY: string[] = []
const DEFAULT_CLAIMS: string[] = []

// ── Layer ──────────────────────────────────────────────────

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const eventStore = yield* EventStore.Service

    const get = Effect.fn("OperatingPicture.get")(function* (options?: GetOptions) {
      const ctx = yield* InstanceState.context

      // ── Workspace: branch & dirty ───────────────────────────────
      let branch = DEFAULT_BRANCH
      let dirtyFiles = DEFAULT_DIRTY
      try {
        const branchResult = yield* git.branch()
        branch = branchResult.current
      } catch (e) {
        log.warn("could not read git branch", { error: String(e) })
      }
      try {
        const status = yield* git.status()
        dirtyFiles = status.files.map((f) => f.path)
      } catch (e) {
        log.warn("could not read git status", { error: String(e) })
      }

      // ── Workspace: claimed files from coordination ──────────────
      let claimedFiles = DEFAULT_CLAIMS
      try {
        claimedFiles = yield* getClaimedFiles()
      } catch (e) {
        log.warn("could not query coordination claims", { error: String(e) })
      }

      // ── Mission ─────────────────────────────────────────────────
      const mission: AgentOperatingPicture["mission"] = {
        id: options?.sessionId ?? ctx.project.id ?? "unknown",
        goal: ctx.project.name ?? "",
        mode: options?.agentName ?? "build",
        phase: "active",
      }

      // ── Authority ───────────────────────────────────────────────
      // Placeholder — authority is derived from agent permissions at query time.
      // Permissions are resolved dynamically per tool call, not pre-computed here.
      const authority: AgentOperatingPicture["authority"] = {
        allowedTools: [],
        deniedTools: [],
        writeScope: [],
      }

      // ── Validation: last event from EventStore ──────────────────
      const validation: AgentOperatingPicture["validation"] = {}
      try {
        const recentEvents = yield* eventStore.query({
          limit: 5,
          order: "desc",
          ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        })
        if (recentEvents.length > 0) {
          const last = recentEvents[0]
          validation.lastCommand = last.toolName ?? last.eventType
          validation.status = last.status ?? "unknown"
          validation.summary = `${last.eventType} by ${last.actor}`
        }
      } catch (e) {
        log.warn("could not query event store", { error: String(e) })
      }

      return {
        mission,
        authority,
        workspace: {
          branch,
          dirtyFiles,
          claimedFiles,
          protectedFiles: ctx.project.doNotTouch ?? [],
        },
        validation,
      }
    })

    return Service.of({ get } as Interface)
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(EventStore.defaultLayer),
)

export * as OperatingPicture from "./operating-picture"
