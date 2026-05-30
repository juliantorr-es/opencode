import { createMemo, For, Show } from "solid-js"
import type { EventStatus, RuntimeEvent } from "@/context/inspector"
import { EVENT_STATUS_COLORS, useInspector } from "@/context/inspector"

// ── Types ──

export interface FileClaim {
  file: string
  shortFile: string
  operations: number
  lastModified: number
  statuses: EventStatus[]
}

export interface MissionInfo {
  currentGoal: string
  currentGoalDetail: string
  phase: string
  activeTool: string | null
  riskLevel: "low" | "medium" | "high"
  riskReason: string
  blockedReason: string | null
  nextAction: string | null
  testsLastRun: { label: string; status: EventStatus; timestamp: number } | null
  gitEventCount: number
  errorRate: number
}

const PHASE_ORDER = ["learning", "plan", "review", "execution", "validation", "stress", "repair"] as const

const RISK_COLORS: Record<string, string> = {
  low: "#2ECC71",
  medium: "#F1C40F",
  high: "#E74C3C",
}

// ── Derivation ──

function buildMissionInfo(events: RuntimeEvent[]): MissionInfo {
  const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp)
  const now = Date.now()
  const fiveMinAgo = now - 5 * 60 * 1000

  // Track in-flight call IDs
  const completedCalls = new Set<string>()
  const startedCalls: RuntimeEvent[] = []

  for (const e of sorted) {
    if (e.callID && (e.status === "succeeded" || e.status === "failed" || e.status === "denied")) {
      completedCalls.add(e.callID)
    }
  }

  for (const e of sorted) {
    if (e.status === "started" && e.callID && !completedCalls.has(e.callID)) {
      startedCalls.push(e)
    }
  }

  // Current goal: first agent event, else first started event, else most recent non-trivial event
  const agentEvent = sorted.find((e) => e.category === "agent" && e.status === "started")
  const inFlight = startedCalls[0]
  const mostRecentNonTrivial = sorted.find((e) => e.category !== "system" && e.category !== "other")

  let currentGoal = "Idle — awaiting activity"
  let currentGoalDetail = ""
  if (agentEvent) {
    currentGoal = agentEvent.type.replace(/^(agent|tool|phase)[:_]/, "").replace(/[:]/g, " → ")
    currentGoal = currentGoal.charAt(0).toUpperCase() + currentGoal.slice(1)
    currentGoalDetail = agentEvent.actor ?? ""
  } else if (inFlight) {
    currentGoal = inFlight.type.replace(/[:_]/g, " → ")
    currentGoal = currentGoal.charAt(0).toUpperCase() + currentGoal.slice(1)
    currentGoalDetail = inFlight.tool ?? inFlight.file ?? ""
  } else if (mostRecentNonTrivial) {
    currentGoal = `Last: ${mostRecentNonTrivial.type.replace(/[:_]/g, " → ")}`
    currentGoalDetail = "[completed]"
  }

  // Phase: most recent event with a phase field
  const phaseEvents = sorted.filter((e) => e.phase)
  const currentPhase = phaseEvents.length > 0
    ? phaseEvents[0].phase!
    : "unknown"

  // Active tool: most recent started tool event
  const activeToolEvent = startedCalls.find((e) => e.category === "tool" || e.tool)
  const activeTool = activeToolEvent?.tool ?? activeToolEvent?.type ?? null

  // Risk level
  const total = events.length
  const failed = events.filter((e) => e.status === "failed" || e.status === "denied").length
  const recentFailed = sorted.filter(
    (e) => e.timestamp >= fiveMinAgo && (e.status === "failed" || e.status === "denied"),
  ).length
  const errorRate = total > 0 ? (failed / total) * 100 : 0

  let riskLevel: "low" | "medium" | "high" = "low"
  let riskReason = ""
  if (recentFailed >= 3 || errorRate > 30) {
    riskLevel = "high"
    riskReason = `${recentFailed} errors in last 5m`
  } else if (recentFailed >= 1 || errorRate > 10) {
    riskLevel = "medium"
    riskReason = `${errorRate.toFixed(0)}% error rate`
  } else {
    riskReason = `${errorRate.toFixed(0)}% error rate`
  }

  // Blocked reason
  const blockedEvent = sorted.find(
    (e) => e.status === "failed" || e.status === "denied",
  )
  const blockedReason = blockedEvent?.error ?? null

  // Next planned action: look at the event pattern — if current phase is execution, next is validation
  const phaseIdx = PHASE_ORDER.indexOf(currentPhase as (typeof PHASE_ORDER)[number])
  const nextAction = phaseIdx >= 0 && phaseIdx < PHASE_ORDER.length - 1
    ? `Proceed to ${PHASE_ORDER[phaseIdx + 1]}`
    : currentPhase === "validation" || currentPhase === "stress"
      ? "Complete and report"
      : currentPhase === "repair"
        ? "Retry stalled wave"
        : null

  // Tests last run
  const testEvent = sorted.find(
    (e) =>
      e.type.includes("test") ||
      e.type.includes("pytest") ||
      e.tool === "smart_bun" ||
      e.tool === "pytest",
  )

  const testsLastRun = testEvent
    ? {
        label: testEvent.tool ?? testEvent.type,
        status: testEvent.status,
        timestamp: testEvent.timestamp,
      }
    : null

  // Git event count
  const gitEventCount = sorted.filter(
    (e) => e.type.includes("git") || e.tool === "smart_git",
  ).length

  return {
    currentGoal,
    currentGoalDetail,
    phase: currentPhase,
    activeTool,
    riskLevel,
    riskReason,
    blockedReason,
    nextAction,
    testsLastRun,
    gitEventCount,
    errorRate,
  }
}

function buildFileClaims(events: RuntimeEvent[]): FileClaim[] {
  const claimMap = new Map<string, FileClaim>()

  for (const e of events) {
    if (!e.file) continue
    const existing = claimMap.get(e.file) ?? {
      file: e.file,
      shortFile: e.file.split("/").pop() ?? e.file,
      operations: 0,
      lastModified: 0,
      statuses: [] as EventStatus[],
    }
    existing.operations++
    if (e.timestamp > existing.lastModified) existing.lastModified = e.timestamp
    if (!existing.statuses.includes(e.status)) existing.statuses.push(e.status)
    claimMap.set(e.file, existing)
  }

  return [...claimMap.values()]
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 8)
}

// ── Helpers ──

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return "just now"
  if (diff < 120_000) return "1m ago"
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 7200_000) return "1h ago"
  return `${Math.floor(diff / 3600_000)}h ago`
}

function statusDot(status: EventStatus): string {
  const color = EVENT_STATUS_COLORS[status]
  return `background: ${color}; box-shadow: 0 0 3px ${color}40`
}

// ── Sub-Components ──

export function MissionStatus() {
  const { events } = useInspector()
  const info = createMemo(() => buildMissionInfo(events()))

  return (
    <div class="flex flex-col gap-1.5">
      {/* Goal */}
      <div class="flex items-start gap-2">
        <span class="text-xs mt-0.5 shrink-0">🎯</span>
        <div class="min-w-0 flex-1">
          <div class="text-[10px] font-medium text-text-muted uppercase tracking-wider">Current Goal</div>
          <div class="text-[11px] text-text truncate font-medium" title={info().currentGoal}>
            {info().currentGoal}
          </div>
          <Show when={info().currentGoalDetail}>
            <div class="text-[9px] text-text-muted truncate">{info().currentGoalDetail}</div>
          </Show>
        </div>
      </div>

      {/* Phase + Active Tool + Risk — 3 columns */}
      <div class="grid grid-cols-3 gap-1">
        {/* Phase */}
        <div class="flex flex-col gap-0.5">
          <span class="text-[9px] font-medium text-text-muted uppercase tracking-wider">Phase</span>
          <div class="flex items-center gap-1">
            <span class="inline-flex items-center justify-center w-4 h-4 rounded text-[9px] bg-background-menu border border-border">
              {info().phase === "unknown" ? "?" : info().phase.charAt(0).toUpperCase()}
            </span>
            <span class="text-[10px] text-text truncate">{info().phase}</span>
          </div>
        </div>

        {/* Active Tool */}
        <div class="flex flex-col gap-0.5">
          <span class="text-[9px] font-medium text-text-muted uppercase tracking-wider">Tool</span>
          <div class="flex items-center gap-1">
            <span class="text-[10px]">🛠</span>
            <Show
              when={info().activeTool}
              fallback={<span class="text-[10px] text-text-muted italic">—</span>}
            >
              <span class="text-[10px] text-text truncate">{info().activeTool}</span>
            </Show>
          </div>
        </div>

        {/* Risk Level */}
        <div class="flex flex-col gap-0.5">
          <span class="text-[9px] font-medium text-text-muted uppercase tracking-wider">Risk</span>
          <div class="flex items-center gap-1">
            <span
              class="w-1.5 h-1.5 rounded-full"
              style={{ background: RISK_COLORS[info().riskLevel] }}
            />
            <span
              class="text-[10px] capitalize"
              style={{ color: RISK_COLORS[info().riskLevel] }}
            >
              {info().riskLevel}
            </span>
            <span class="text-[8px] text-text-muted truncate">{info().riskReason}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function FileClaimsRow(props: { claim: FileClaim }) {
  return (
    <div class="flex items-center gap-1.5 px-1 py-0.5 text-[10px] rounded hover:bg-background-menu transition-colors">
      <span class="text-text-muted shrink-0">📄</span>
      <span class="flex-1 truncate text-text" title={props.claim.file}>
        {props.claim.shortFile}
      </span>
      <div class="flex items-center gap-1 shrink-0">
        <span class="text-text-muted">{props.claim.operations}</span>
        <For each={props.claim.statuses.slice(0, 2)}>
          {(s) => (
            <span
              class="w-1 h-1 rounded-full inline-block"
              style={statusDot(s)}
            />
          )}
        </For>
      </div>
    </div>
  )
}

export function ClaimsMap() {
  const { events } = useInspector()
  const claims = createMemo(() => buildFileClaims(events()))

  return (
    <div class="flex flex-col gap-0.5">
      <div class="flex items-center justify-between">
        <span class="text-[9px] font-medium text-text-muted uppercase tracking-wider">File Claims</span>
        <span class="text-[9px] text-text-muted">{claims().length} files</span>
      </div>
      <Show
        when={claims().length > 0}
        fallback={
          <div class="text-[10px] text-text-muted italic px-1 py-2 text-center">
            No file activity yet
          </div>
        }
      >
        <div class="flex flex-col gap-0.5 max-h-28 overflow-y-auto">
          <For each={claims()}>
            {(claim) => <FileClaimsRow claim={claim} />}
          </For>
        </div>
      </Show>
    </div>
  )
}

// ── Main Component ──

export default function OperatingPicture() {
  const { events, stats, connected } = useInspector()
  const info = createMemo(() => buildMissionInfo(events()))

  return (
    <div class="flex flex-col h-full select-none">
      {/* Header */}
      <div class="flex items-center justify-between px-2 py-1.5 border-b border-border">
        <div class="flex items-center gap-1.5">
          <span class="text-xs">🖥</span>
          <span class="text-[11px] font-medium text-text">Operating Picture</span>
        </div>
        <div class="flex items-center gap-1">
          <span
            class={`w-1.5 h-1.5 rounded-full ${
              connected() ? "bg-green-500" : "bg-red-500 animate-pulse"
            }`}
          />
          <span class="text-[9px] text-text-muted">{stats().total} ev</span>
        </div>
      </div>

      {/* Scrollable content */}
      <div class="flex-1 overflow-y-auto space-y-2 p-2">
        {/* Mission Status */}
        <div class="rounded border border-border bg-background-element/50 p-1.5">
          <MissionStatus />
        </div>

        {/* Tests Last Run + Git Status — side by side */}
        <div class="grid grid-cols-2 gap-1">
          {/* Tests Last Run */}
          <div class="rounded border border-border bg-background-element/50 p-1.5">
            <div class="flex flex-col gap-0.5">
              <span class="text-[9px] font-medium text-text-muted uppercase tracking-wider">Tests</span>
              <Show
                when={info().testsLastRun}
                fallback={<span class="text-[10px] text-text-muted italic">No tests recorded</span>}
              >
                <div class="flex items-center gap-1">
                  <span
                    class="w-1 h-1 rounded-full inline-block"
                    style={statusDot(info().testsLastRun!.status)}
                  />
                  <span class="text-[10px] text-text truncate">{info().testsLastRun!.label}</span>
                </div>
                <span class="text-[8px] text-text-muted">
                  {fmtTime(info().testsLastRun!.timestamp)}
                </span>
              </Show>
            </div>
          </div>

          {/* Git Status */}
          <div class="rounded border border-border bg-background-element/50 p-1.5">
            <div class="flex flex-col gap-0.5">
              <span class="text-[9px] font-medium text-text-muted uppercase tracking-wider">Git</span>
              <Show
                when={info().gitEventCount > 0}
                fallback={<span class="text-[10px] text-text-muted italic">No git activity</span>}
              >
                <div class="flex items-center gap-1">
                  <span class="text-[10px]">⎇</span>
                  <span class="text-[10px] text-text">{info().gitEventCount} ops</span>
                </div>
                <span class="text-[8px] text-text-muted">in this session</span>
              </Show>
            </div>
          </div>
        </div>

        {/* File Claims Map */}
        <div class="rounded border border-border bg-background-element/50 p-1.5">
          <ClaimsMap />
        </div>

        {/* Blocked Reason */}
        <Show when={info().blockedReason}>
          <div class="rounded border border-red-500/30 bg-red-500/5 p-1.5">
            <div class="flex items-start gap-1.5">
              <span class="text-xs mt-0.5 shrink-0">🚫</span>
              <div class="min-w-0 flex-1">
                <div class="text-[9px] font-medium text-red-400 uppercase tracking-wider mb-0.5">
                  Blocked
                </div>
                <div class="text-[10px] text-red-300 break-words">
                  {info().blockedReason}
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* Next Planned Action */}
        <Show when={info().nextAction}>
          <div class="rounded border border-border bg-background-element/50 p-1.5">
            <div class="flex items-start gap-1.5">
              <span class="text-xs mt-0.5 shrink-0">⏭</span>
              <div class="min-w-0 flex-1">
                <div class="text-[9px] font-medium text-text-muted uppercase tracking-wider mb-0.5">
                  Next Action
                </div>
                <div class="text-[10px] text-text truncate">
                  {info().nextAction}
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* Error rate bar */}
        <div class="flex items-center gap-1.5 px-1 pt-1">
          <div class="flex-1 h-1 rounded-full bg-background-menu overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(info().errorRate, 100)}%`,
                background: info().errorRate > 30 ? "#E74C3C" : info().errorRate > 10 ? "#F1C40F" : "#2ECC71",
              }}
            />
          </div>
          <span class="text-[8px] text-text-muted shrink-0">{info().errorRate.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  )
}
