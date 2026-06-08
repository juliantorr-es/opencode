/**
 * Control-Plane Query API
 *
 * Governed read interface for control-plane entities. All queries go through
 * this module — no direct PGlite or filesystem access from tools, cockpit, or agents.
 *
 * Every query is authorized (caller identity checked) and logged for audit.
 */
import { Effect } from "effect"
import type {
  ControlPlaneRepository,
  CampaignEntity,
  MissionEntity,
  LaneEntity,
  TaskEntity,
  CampaignQuery,
  MissionQuery,
  LaneQuery,
  TaskQuery,
} from "./repository"

// ── Caller Identity ──────────────────────────────────────────────────────────

export interface CallerIdentity {
  kind: "tool" | "cockpit" | "agent" | "system"
  id: string
  sessionId?: string
}

// ── Query Audit Log ──────────────────────────────────────────────────────────

interface QueryAuditEntry {
  caller: CallerIdentity
  queryType: string
  queryParams: unknown
  timestamp: number
  resultCount: number
  durationMs: number
}

const auditLog: QueryAuditEntry[] = []

function logQuery(entry: QueryAuditEntry) {
  auditLog.push(entry)
}

export function getAuditLog(): QueryAuditEntry[] {
  return [...auditLog]
}

// ── Authorization ────────────────────────────────────────────────────────────

function authorizeRead(caller: CallerIdentity, entityType: string): Effect.Effect<void, Error> {
  return Effect.sync(() => {
    // System and cockpit have full read access
    if (caller.kind === "system" || caller.kind === "cockpit") return

    // Tools can read within their session scope
    if (caller.kind === "tool" && caller.sessionId) return

    // Agents can read within their session scope
    if (caller.kind === "agent" && caller.sessionId) return

    throw new Error(`Unauthorized read access to ${entityType} by ${caller.kind}:${caller.id}`)
  })
}

// ── Query API ────────────────────────────────────────────────────────────────

export function createQueryAPI(repo: ControlPlaneRepository) {
  return {
    // Campaign queries
    getCampaign: (caller: CallerIdentity, id: string) =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* authorizeRead(caller, "campaign")
        const result = yield* repo.getCampaign(id)
        logQuery({ caller, queryType: "getCampaign", queryParams: { id }, timestamp: start, resultCount: result ? 1 : 0, durationMs: Date.now() - start })
        return result
      }),

    listCampaigns: (caller: CallerIdentity, query?: CampaignQuery) =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* authorizeRead(caller, "campaign")
        const results = yield* repo.listCampaigns(query)
        logQuery({ caller, queryType: "listCampaigns", queryParams: query ?? {}, timestamp: start, resultCount: results.length, durationMs: Date.now() - start })
        return results
      }),

    // Mission queries
    getMission: (caller: CallerIdentity, id: string) =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* authorizeRead(caller, "mission")
        const result = yield* repo.getMission(id)
        logQuery({ caller, queryType: "getMission", queryParams: { id }, timestamp: start, resultCount: result ? 1 : 0, durationMs: Date.now() - start })
        return result
      }),

    listMissions: (caller: CallerIdentity, query?: MissionQuery) =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* authorizeRead(caller, "mission")
        const results = yield* repo.listMissions(query)
        logQuery({ caller, queryType: "listMissions", queryParams: query ?? {}, timestamp: start, resultCount: results.length, durationMs: Date.now() - start })
        return results
      }),

    listMissionsByCampaign: (caller: CallerIdentity, campaignId: string) =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* authorizeRead(caller, "mission")
        const results = yield* repo.listMissions({ campaignId })
        logQuery({ caller, queryType: "listMissionsByCampaign", queryParams: { campaignId }, timestamp: start, resultCount: results.length, durationMs: Date.now() - start })
        return results
      }),

    // Lane queries
    getLane: (caller: CallerIdentity, id: string) =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* authorizeRead(caller, "lane")
        const result = yield* repo.getLane(id)
        logQuery({ caller, queryType: "getLane", queryParams: { id }, timestamp: start, resultCount: result ? 1 : 0, durationMs: Date.now() - start })
        return result
      }),

    listLanes: (caller: CallerIdentity, query?: LaneQuery) =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* authorizeRead(caller, "lane")
        const results = yield* repo.listLanes(query)
        logQuery({ caller, queryType: "listLanes", queryParams: query ?? {}, timestamp: start, resultCount: results.length, durationMs: Date.now() - start })
        return results
      }),

    // Task queries
    getTask: (caller: CallerIdentity, id: string) =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* authorizeRead(caller, "task")
        const result = yield* repo.getTask(id)
        logQuery({ caller, queryType: "getTask", queryParams: { id }, timestamp: start, resultCount: result ? 1 : 0, durationMs: Date.now() - start })
        return result
      }),

    listTasks: (caller: CallerIdentity, query?: TaskQuery) =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* authorizeRead(caller, "task")
        const results = yield* repo.listTasks(query)
        logQuery({ caller, queryType: "listTasks", queryParams: query ?? {}, timestamp: start, resultCount: results.length, durationMs: Date.now() - start })
        return results
      }),

    // Board-level query (used by task_board tool)
    getBoard: (caller: CallerIdentity, campaignId?: string) =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* authorizeRead(caller, "board")

        const cQuery: CampaignQuery = campaignId ? { campaignId } : {}
        const campaigns = yield* repo.listCampaigns({ ...cQuery, orderBy: "id", orderDir: "asc" })

        const board: Array<{
          campaign: CampaignEntity
          missions: MissionEntity[]
          lanes: LaneEntity[]
          tasks: TaskEntity[]
        }> = []

        for (const campaign of campaigns) {
          const missions = yield* repo.listMissions({ campaignId: campaign.id })
          const lanes: LaneEntity[] = []
          const tasks: TaskEntity[] = []

          for (const mission of missions) {
            const ml = yield* repo.listLanes({ missionId: mission.id })
            lanes.push(...ml)
            for (const lane of ml) {
              const tl = yield* repo.listTasks({ laneId: lane.id })
              tasks.push(...tl)
            }
          }

          board.push({ campaign, missions, lanes, tasks })
        }

        logQuery({ caller, queryType: "getBoard", queryParams: { campaignId }, timestamp: start, resultCount: campaigns.length, durationMs: Date.now() - start })
        return board
      }),
  }
}

export type QueryAPI = ReturnType<typeof createQueryAPI>
