import { Context, Effect, Layer } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Authority } from "@/agent"
import { Scratchpad } from "@/agent"
import { Git } from "@/git"
import { EventStore } from "@/event"
import { InstanceState } from "@/effect/instance-state"
import type { RuntimeEvent as RuntimeEventType } from "@/event/runtime-event"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "context-packet" })

// ── Types ──────────────────────────────────────────────────

export interface Freshness {
  fetchedAt: string
  eventLagMs: number
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
    externalChangesDetected: boolean
  }
  claims: {
    owned: string[]
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
const DEFAULT_CLAIMS: string[] = []

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

// ── Layer ──────────────────────────────────────────────────

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* Authority.Service
    const eventStore = yield* EventStore.Service
    const git = yield* Git.Service
    const scratchpad = yield* Scratchpad.Service

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

        const workspace: ContextPacketL1["workspace"] = {
          branch,
          dirtyFiles,
          externalChangesDetected: dirtyFiles.length > 0,
        }

        // ── Claims (from coordination events) ─────────────
        let ownedFiles = DEFAULT_CLAIMS
        let conflictFiles: string[] = []
        try {
          const recentEvents = yield* eventStore.query({
            sessionId,
            limit: 100,
            order: "desc",
          })
          ownedFiles = extractFilePaths(recentEvents)
          conflictFiles = ownedFiles.filter((f) => dirtyFiles.includes(f))
        } catch (e) {
          log.warn("could not query events for claims", { error: String(e) })
        }

        const claims: ContextPacketL1["claims"] = {
          owned: ownedFiles,
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
          const candidates = [...succeededEvents, ...failedEvents].filter(
            (e) =>
              e.eventType === "validation" ||
              e.toolName === "smart_bun" ||
              e.eventType === "typecheck" ||
              e.eventType === "test",
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
        } catch (e) {
          log.warn("could not build working set", { error: String(e) })
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
          recommendedNextContext,
          _freshness: {
            fetchedAt: new Date(fetchedAt).toISOString(),
            eventLagMs: Date.now() - fetchedAt,
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

    return Service.of({
      assembleL1,
      assembleL2,
      getCurrentPacket,
    } as Interface)
  }),
)




