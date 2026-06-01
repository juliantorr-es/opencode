import { Context, Duration, Effect, Fiber, Layer, Ref, Scope, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Authority } from "@/agent"
import { Scratchpad } from "@/agent"
import { Git } from "@/git"
import { EventStore, EventName } from "@/event"
import { InstanceState } from "@/effect/instance-state"
import type { RuntimeEvent as RuntimeEventType } from "@/event/runtime-event"
import * as FileMemory from "./file-memory"
import * as Log from "@opencode-ai/core/util/log"
import * as DuckDB from "../storage/db.duckdb"
import { ContextInvalidationBus } from "./invalidation-bus"
import { queryAgentHeatmap, rankWorkingSetFull } from "./duckdb-rank"
import type { AgentHeatmapEntry, RankedFile } from "./duckdb-rank"
import { Coordination } from "@/tool/coordination"
import { createHash } from "node:crypto"

const log = Log.create({ service: "context-packet" })

// ── Types ──────────────────────────────────────────────────

export interface Freshness {
  fetchedAt: string
  eventLagMs: number
  contentFresh: boolean
  fileCount: number
  stalePaths: string[]
}

export interface ContextPacketL1 {
  mission: {
    id: string
    goal: string
    phase: string
    mode: string
  }
  authority: {
    allowedTools: string[]
    deniedTools: string[]
    writeScope: string[]
    protectedPaths: string[]
    stopConditions: string[]
  }
  workspace: {
    branch: string
    dirtyFiles: string[]
    dirtyBreakdown: {
      agentEdits: string[]
      externalEdits: string[]
      preExistingDirty: string[]
      generatedFiles: string[]
      snapshotUpdates: string[]
    }
  }
  claims: {
    claimed: string[]
    conflicts: string[]
  }
  latestValidation?: {
    status: string
    summary: string
    failedTests: Array<{ name: string; file: string; line: number }>
  }
  lastError?: {
    code: string
    message: string
    tool: string
    recoverable: boolean
  }
  _freshness: Freshness
}

export interface ContextPacketL2 {
  workingSet: Array<{
    path: string
    freshness: string
    lastEvent: string
    summary: string
  }>
  relatedTests: string[]
  agentHeatmap: AgentHeatmapEntry[]
  recommendedNextContext: Array<{
    tool: string
    path: string
    reason: string
  }>
  _freshness: Freshness
}

export interface ContextPacket {
  l1: ContextPacketL1
  l2?: ContextPacketL2
  packetVersion: number
}

// ── Service Interface ──────────────────────────────────────

export interface Interface {
  readonly assembleL1: (sessionId: string, cwd?: string) => Effect.Effect<ContextPacketL1>
  readonly assembleL2: (sessionId: string, cwd?: string) => Effect.Effect<ContextPacketL2>
  readonly getCurrentPacket: (
    sessionId: string,
    includeL2?: boolean,
    cwd?: string,
  ) => Effect.Effect<ContextPacket>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ContextPacket") {}

export const use = serviceUse(Service)

// ── Constants ──────────────────────────────────────────────

const PACKET_VERSION = 1
const DEFAULT_BRANCH = "unknown"
const DEFAULT_DIRTY: string[] = []


// ── Helpers ────────────────────────────────────────────────

/**
 * Extract unique file paths from a list of runtime events.
 * Returns deduplicated paths ordered by first occurrence (most recent first).
 */
function extractFilePaths(events: RuntimeEventType[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const ev of events) {
    if (ev.filePath && !seen.has(ev.filePath)) {
      seen.add(ev.filePath)
      result.push(ev.filePath)
    }
  }
  return result
}

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/

function isTestPath(p: string): boolean {
  return TEST_FILE_RE.test(p)
}

// ── Dirty file classification ─────────────────────────────

const GENERATED_FILE_PATTERNS = [
  "node_modules/",
  "/dist/",
  "/.build/",
  ".generated.",
]

function isGeneratedFile(path: string): boolean {
  return GENERATED_FILE_PATTERNS.some((p) => path.includes(p))
}

function isSnapshotFile(path: string): boolean {
  return (
    path.endsWith(".snap") ||
    path.endsWith(".lock") ||
    path.endsWith("pnpm-lock.yaml") ||
    path.endsWith("bun.lockb")
  )
}

type DirtyCategory = "agentEdits" | "externalEdits" | "preExistingDirty" | "generatedFiles" | "snapshotUpdates"

function classifyDirtyFile(
  path: string,
  context: { claimedFiles: string[]; recentFilePaths: string[] },
): DirtyCategory {
  if (context.claimedFiles.includes(path)) return "agentEdits"
  if (isGeneratedFile(path)) return "generatedFiles"
  if (isSnapshotFile(path)) return "snapshotUpdates"
  if (context.recentFilePaths.includes(path)) return "externalEdits"
  return "preExistingDirty"
}

// ── Layer ──────────────────────────────────────────────────

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* Authority.Service
    const eventStore = yield* EventStore.Service
    const git = yield* Git.Service
    const scratchpad = yield* Scratchpad.Service
    const fileMemory = yield* FileMemory.Service
    const duckdb = yield* DuckDB.Service

    // ── assembleL1 ─────────────────────────────────────────
    const assembleL1 = Effect.fn("ContextPacket.assembleL1")(
      function* (sessionId: string, cwd?: string) {
        const fetchedAt = Date.now()
        const ctx = yield* InstanceState.context
        const workDir = cwd ?? ctx.directory

        // ── Mission ───────────────────────────────────────
        const scratch = yield* scratchpad.get
        const contract = yield* authority.getContract()

        const mission: ContextPacketL1["mission"] = {
          id: sessionId || ctx.project.id || "unknown",
          goal: scratch.hypothesis || ctx.project.name || "",
          phase: scratch.nextAction ? "active" : "idle",
          mode: contract.mode,
        }

        // ── Authority ─────────────────────────────────────
        const authoritySection: ContextPacketL1["authority"] = {
          allowedTools: [...contract.mayRun],
          deniedTools: [...contract.mustAskBefore],
          writeScope: [...contract.mayWrite],
          protectedPaths: [...contract.mustNotWrite],
          stopConditions: [...contract.stopConditions],
        }

        // ── Workspace ─────────────────────────────────────
        let branch = DEFAULT_BRANCH
        let dirtyFiles = DEFAULT_DIRTY
        try {
          const b = yield* git.branch(workDir)
          branch = b ?? DEFAULT_BRANCH
        } catch (e) {
          log.warn("could not read git branch", { error: String(e) })
        }
        try {
          const status = yield* git.status(workDir)
          dirtyFiles = status.map((i) => i.file)
        } catch (e) {
          log.warn("could not read git status", { error: String(e) })
        }

        // ── Claims ───────────────────────────────────────
        let claimedFiles: string[] = []
        let recentFilePaths: string[] = []
        let conflictFiles: string[] = []
        try {
          const activeReservations = yield* Coordination.getSessionReservations(sessionId)
          if (activeReservations.length > 0) {
            claimedFiles = activeReservations.map((r: { path: string }) => r.path)
          }
          // Extract event-derived paths for informational context (not authority)
          try {
            const recentEvents = yield* eventStore.query({
              sessionId,
              limit: 100,
              order: "desc",
            })
            recentFilePaths = extractFilePaths(recentEvents)
          } catch {
            // Non-critical fallback
          }
          // Cross-session conflict detection via claim-ledger with digest-backed verification
          if (dirtyFiles.length > 0) {
            const reservations = yield* Effect.forEach(
              dirtyFiles,
              (f) => Coordination.checkPathReserved(f),
              { concurrency: "unbounded" },
            )
            conflictFiles = dirtyFiles.filter((_, i) => {
              const res = reservations[i]
              return res !== null && res.sessionId !== sessionId
            })
            // Digest-backed external change detection for this session's reservations.
            // For each reserved file with a baseDigest, compute current SHA-256 and
            // compare. A mismatch without an agent edit event means external tampering.
            for (const res of reservations) {
              if (!res || res.sessionId !== sessionId || !res.baseDigest) continue
              yield* Effect.tryPromise(async () => {
                const file = Bun.file(res.path!)
                if (!(await file.exists())) return
                const content = await file.text()
                const currentDigest = createHash("sha256").update(content).digest("hex")
                if (currentDigest !== res.baseDigest && !recentFilePaths.includes(res.path!)) {
                  conflictFiles.push(res.path!)
                }
              }).pipe(Effect.catchCause(() => Effect.void))
            }
          }
        } catch (e) {
          log.warn("could not query coordination for claims", { error: String(e) })
        }

        const dirtyBreakdown = {
          agentEdits: [] as string[],
          externalEdits: [] as string[],
          preExistingDirty: [] as string[],
          generatedFiles: [] as string[],
          snapshotUpdates: [] as string[],
        }
        for (const f of dirtyFiles) {
          const cat = classifyDirtyFile(f, { claimedFiles, recentFilePaths })
          dirtyBreakdown[cat].push(f)
        }
        const workspace: ContextPacketL1["workspace"] = {
          branch,
          dirtyFiles,
          dirtyBreakdown,
        }

        const claims: ContextPacketL1["claims"] = {
          claimed: claimedFiles,
          conflicts: conflictFiles,
        }

        // ── Latest Validation ─────────────────────────────
        let latestValidation: ContextPacketL1["latestValidation"] = undefined
        try {
          const succeededEvents = yield* eventStore.query({
            sessionId,
            status: "succeeded",
            limit: 5,
            order: "desc",
          })
          const failedEvents = yield* eventStore.query({
            sessionId,
            status: "failed",
            limit: 5,
            order: "desc",
          })
          // Only consider validation events that occurred after the latest edit
          let lastEditTs: string | undefined
          try {
            const editEvents = yield* eventStore.query({
              sessionId,
              limit: 20,
              order: "desc",
            })
            lastEditTs = editEvents.find(
              (e) => e.eventType === EventName.FileEdited,
            )?.ts
          } catch {
            lastEditTs = undefined
          }
          const candidates = [...succeededEvents, ...failedEvents].filter(
            (e) =>
              (e.eventType === EventName.ValidationCompleted ||
               e.eventType === EventName.ValidationFailure) &&
              (!lastEditTs || e.ts > lastEditTs),
          )
          const best = candidates.sort((a, b) => b.ts.localeCompare(a.ts))[0]
          if (best) {
            latestValidation = {
              status: best.status ?? "unknown",
              summary: best.errorMessage ?? `${best.eventType} ${best.status ?? "completed"}`,
              failedTests: [],
            }
          }
        } catch (e) {
          log.warn("could not query validation events", { error: String(e) })
        }

        // ── Last Error ────────────────────────────────────
        let lastError: ContextPacketL1["lastError"] = undefined
        try {
          const errorEvents = yield* eventStore.query({
            sessionId,
            status: "failed",
            limit: 1,
            order: "desc",
          })
          if (errorEvents.length > 0) {
            const ev = errorEvents[0]
            lastError = {
              code: ev.errorCode ?? "UNKNOWN",
              message: ev.errorMessage ?? ev.eventType,
              tool: ev.toolName ?? "unknown",
              recoverable: ev.recoverable ?? false,
            }
          }
        } catch (e) {
          log.warn("could not query error events", { error: String(e) })
        }

        // ── Content-based freshness from FileMemory ────────
        let contentFresh = true
        let stalePaths: string[] = []
        let fileCount = 0
        try {
          const allFiles = yield* fileMemory.getAll()
          fileCount = allFiles.length
          stalePaths = allFiles
            .filter((f) => f.freshness !== "fresh")
            .map((f) => f.path)
          contentFresh = stalePaths.length === 0
        } catch (e) {
          log.warn("could not read file memory for freshness", { error: String(e) })
        }

        return {
          mission,
          authority: authoritySection,
          workspace,
          claims,
          latestValidation,
          lastError,
          _freshness: {
            fetchedAt: new Date(fetchedAt).toISOString(),
            eventLagMs: Date.now() - fetchedAt,
            contentFresh,
            fileCount,
            stalePaths,
          },
        }
      },
    )

    // ── assembleL2 ─────────────────────────────────────────
    const assembleL2 = Effect.fn("ContextPacket.assembleL2")(
      function* (sessionId: string, cwd?: string) {
        const fetchedAt = Date.now()
        const ctx = yield* InstanceState.context
        const workDir = cwd ?? ctx.directory

        // ── Working Set ───────────────────────────────────
        let workingSet: ContextPacketL2["workingSet"] = []
        let relatedTests: string[] = []
        try {
          // Try DuckDB-backed multi-factor ranking first
          const ranked = yield* rankWorkingSetFull(duckdb, sessionId, 15).pipe(
            Effect.catch(() => Effect.succeed(null as RankedFile[] | null)),
          )

          if (ranked && ranked.length > 0) {
            // DuckDB ranking succeeded — use weighted multi-factor scores
            workingSet = ranked.map((r) => ({
              path: r.filePath,
              freshness: r.lastAccess ?? new Date(fetchedAt).toISOString(),
              lastEvent: `score: ${r.score.toFixed(2)}`,
              summary: `recency=${r.recencyScore.toFixed(2)}, edits=${r.editCount}, failures=${r.failureCount}`,
            }))

            // Collect test paths from DuckDB working set
            const testPaths = new Set<string>()
            for (const r of ranked) {
              if (isTestPath(r.filePath)) testPaths.add(r.filePath)
            }
            try {
              const status = yield* git.status(workDir)
              for (const item of status) {
                if (isTestPath(item.file)) testPaths.add(item.file)
              }
            } catch {
              // non-fatal
            }
            relatedTests = [...testPaths].slice(0, 10)
          } else {
            // Fallback to EventStore-only recency ranking when DuckDB not ready
            const fileEvents = yield* eventStore.query({
              sessionId,
              limit: 50,
              order: "desc",
            })
            // Deduplicate by file path, keeping the latest event per file
            const fileMap = new Map<
              string,
              { lastEvent: string; summary: string; ts: string }
            >()
            for (const ev of fileEvents) {
              if (!ev.filePath) continue
              const existing = fileMap.get(ev.filePath)
              if (!existing || ev.ts > existing.ts) {
                fileMap.set(ev.filePath, {
                  lastEvent: `${ev.eventType}${ev.status ? ` (${ev.status})` : ""}`,
                  summary: `${ev.actor}: ${ev.eventType}${ev.toolName ? ` via ${ev.toolName}` : ""}`,
                  ts: ev.ts,
                })
              }
            }
            // Rank by recency
            const sorted = [...fileMap.entries()]
              .sort(([, a], [, b]) => b.ts.localeCompare(a.ts))
              .slice(0, 15)
            workingSet = sorted.map(([path, info]) => ({
              path,
              freshness: info.ts,
              lastEvent: info.lastEvent,
              summary: info.summary,
            }))
            // Collect test paths from the working set
            const testPaths = new Set<string>()
            for (const [path] of sorted) {
              if (isTestPath(path)) testPaths.add(path)
            }
            // Also scan git status for test files
            try {
              const status = yield* git.status(workDir)
              for (const item of status) {
                if (isTestPath(item.file)) testPaths.add(item.file)
              }
            } catch {
              // non-fatal
            }
            relatedTests = [...testPaths].slice(0, 10)
          }
        } catch (e) {
          log.warn("could not build working set", { error: String(e) })
        }

        // ── Agent Heatmap ─────────────────────────────────
        let agentHeatmap: AgentHeatmapEntry[] = []
        if (workingSet.length > 0) {
          const topFiles = workingSet.slice(0, 5).map((w) => w.path)
          for (const fp of topFiles) {
            const entries = yield* queryAgentHeatmap(duckdb, fp).pipe(
              Effect.catch(() => Effect.succeed([] as AgentHeatmapEntry[])),
            )
            for (const entry of entries) {
              const key = `${entry.agentName}:${entry.filePath}`
              if (!agentHeatmap.some((e) => `${e.agentName}:${e.filePath}` === key)) {
                agentHeatmap.push(entry)
              }
            }
          }
        }

        // ── Recommended Next Context ──────────────────────
        const recommendedNextContext: ContextPacketL2["recommendedNextContext"] = []
        if (workingSet.length > 0) {
          recommendedNextContext.push({
            tool: "read_source",
            path: workingSet[0].path,
            reason: "Most recently active file in working set",
          })
        }
        if (relatedTests.length > 0) {
          recommendedNextContext.push({
            tool: "smart_bun",
            path: relatedTests[0],
            reason: "Active test file — run related tests",
          })
        }

        return {
          workingSet,
          relatedTests,
          agentHeatmap,
          recommendedNextContext,
          _freshness: {
            fetchedAt: new Date(fetchedAt).toISOString(),
            eventLagMs: Date.now() - fetchedAt,
            contentFresh: true,
            fileCount: workingSet.length,
            stalePaths: [],
          },
        }
      },
    )

    // ── getCurrentPacket ───────────────────────────────────
    const getCurrentPacket = Effect.fn("ContextPacket.getCurrentPacket")(
      function* (sessionId: string, includeL2?: boolean, cwd?: string) {
        const l1 = yield* assembleL1(sessionId, cwd)
        let l2: ContextPacketL2 | undefined
        if (includeL2) {
          l2 = yield* assembleL2(sessionId, cwd)
        }
        return {
          l1,
          l2,
          packetVersion: PACKET_VERSION,
        }
      },
    )

    const invalidationBus = yield* ContextInvalidationBus

    // ── Working set ranking invalidation subscription ─────
    const scope = yield* Scope.Scope
    yield* (Effect.gen(function* () {
      const invalidationStream = yield* invalidationBus.subscribe("working_set_ranking")
      yield* Stream.runForEach(invalidationStream, () =>
        Effect.sync(() => log.debug("working set ranking invalidated — next assembleL2 will re-query DuckDB")),
      )
    })).pipe(Effect.forkIn(scope))

    return Service.of({
      assembleL1,
      assembleL2,
      getCurrentPacket,
    } as unknown as Interface)
  }),
)




