import { createMemo, createSignal, For, Index, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useInspector, type RuntimeEvent } from "@/context/inspector"
import { showToast } from "@tribunus/ui/toast"

// ── Types ──

type MilestoneType =
  | "baseline"
  | "plan-accepted"
  | "files-claimed"
  | "patch-applied"
  | "tests-failed"
  | "tests-passed"
  | "checkpoint-created"
  | "pr-ready"

interface MilestoneNode {
  id: string
  type: MilestoneType
  label: string
  timestamp: number
  status: "completed" | "failed" | "active" | "pending"
  events: RuntimeEvent[]
  derived: boolean
}

const MILESTONE_META: Record<
  MilestoneType,
  { icon: string; color: string; order: number }
> = {
  baseline: { icon: "●", color: "bg-sky-500", order: 0 },
  "plan-accepted": { icon: "📋", color: "bg-blue-500", order: 1 },
  "files-claimed": { icon: "🔍", color: "bg-indigo-500", order: 2 },
  "patch-applied": { icon: "📝", color: "bg-violet-500", order: 3 },
  "tests-failed": { icon: "❌", color: "bg-red-500", order: 4 },
  "tests-passed": { icon: "✅", color: "bg-emerald-500", order: 5 },
  "checkpoint-created": { icon: "💾", color: "bg-teal-500", order: 6 },
  "pr-ready": { icon: "🚀", color: "bg-amber-500", order: 7 },
}

// ── Milestone derivation ──

function buildMilestones(events: RuntimeEvent[], sessionID: string): MilestoneNode[] {
  const sessionEvents = events
    .filter((e) => e.sessionID === sessionID)
    .sort((a, b) => a.timestamp - b.timestamp)

  if (sessionEvents.length === 0) return []

  const nodes: MilestoneNode[] = []

  // 1. Baseline — first event for this session
  nodes.push({
    id: "baseline",
    type: "baseline",
    label: "Baseline",
    timestamp: sessionEvents[0].timestamp,
    status: "completed",
    events: [],
    derived: false,
  })

  // Track whether we've seen a prompt cycle
  let inCycle = false
  let cycleEvents: RuntimeEvent[] = []

  const flushCycleCheckpoint = () => {
    if (cycleEvents.length === 0) return
    const mid = cycleEvents[Math.floor(cycleEvents.length / 2)]
    nodes.push({
      id: `checkpoint-${mid.id}`,
      type: "checkpoint-created",
      label: "Checkpoint created",
      timestamp: mid.timestamp,
      status: "completed",
      events: [...cycleEvents],
      derived: true,
    })
    cycleEvents = []
  }

  let i = 0
  while (i < sessionEvents.length) {
    const event = sessionEvents[i]

    // Track all events in the current cycle for checkpoint synthesis
    if (inCycle) {
      cycleEvents.push(event)
    }

    if (
      event.type === "session.next.prompted" ||
      event.type === "session.next.synthetic"
    ) {
      // End previous cycle, start new one
      if (inCycle) flushCycleCheckpoint()
      inCycle = true
      cycleEvents = [event]

      nodes.push({
        id: `plan-${event.id}`,
        type: "plan-accepted",
        label: "Plan accepted",
        timestamp: event.timestamp,
        status: "completed",
        events: [event],
        derived: false,
      })
    } else if (event.type === "session.next.tool.called") {
      const toolEvents: RuntimeEvent[] = [event]
      while (i + 1 < sessionEvents.length) {
        const next = sessionEvents[i + 1]
        if (next.type === "session.next.tool.called") {
          toolEvents.push(next)
          i++
        } else break
      }
      nodes.push({
        id: `files-${toolEvents[0].id}`,
        type: "files-claimed",
        label: "Files claimed",
        timestamp: toolEvents[0].timestamp,
        status: "completed",
        events: toolEvents,
        derived: false,
      })
    } else if (event.type === "file.edited") {
      const fileEvents: RuntimeEvent[] = [event]
      while (i + 1 < sessionEvents.length) {
        const next = sessionEvents[i + 1]
        if (next.type === "file.edited") {
          fileEvents.push(next)
          i++
        } else break
      }
      nodes.push({
        id: `patch-${fileEvents[0].id}`,
        type: "patch-applied",
        label: "Patch applied",
        timestamp: fileEvents[0].timestamp,
        status: "completed",
        events: fileEvents,
        derived: false,
      })
    } else if (event.type === "session.next.tool.failed") {
      const failEvents: RuntimeEvent[] = [event]
      while (i + 1 < sessionEvents.length) {
        const next = sessionEvents[i + 1]
        if (next.type === "session.next.tool.failed") {
          failEvents.push(next)
          i++
        } else break
      }
      nodes.push({
        id: `fail-${failEvents[0].id}`,
        type: "tests-failed",
        label: "Tests failed",
        timestamp: failEvents[0].timestamp,
        status: "failed",
        events: failEvents,
        derived: false,
      })
    } else if (event.type === "session.next.tool.success") {
      const successEvents: RuntimeEvent[] = [event]
      while (i + 1 < sessionEvents.length) {
        const next = sessionEvents[i + 1]
        if (next.type === "session.next.tool.success") {
          successEvents.push(next)
          i++
        } else break
      }
      nodes.push({
        id: `pass-${successEvents[0].id}`,
        type: "tests-passed",
        label: "Tests passed",
        timestamp: successEvents[0].timestamp,
        status: "completed",
        events: successEvents,
        derived: false,
      })
    } else if (event.type === "session.compacted") {
      flushCycleCheckpoint()
      inCycle = false
      nodes.push({
        id: `pr-${event.id}`,
        type: "pr-ready",
        label: "PR ready",
        timestamp: event.timestamp,
        status: "completed",
        events: [event],
        derived: false,
      })
    }

    i++
  }

  // Flush remaining cycle as checkpoint
  if (inCycle) flushCycleCheckpoint()

  // Mark the next logical pending milestone after the last completed one
  markNextPending(nodes)

  return nodes
}

function markNextPending(nodes: MilestoneNode[]): void {
  const order: MilestoneType[] = [
    "baseline",
    "plan-accepted",
    "files-claimed",
    "patch-applied",
    "tests-failed",
    "tests-passed",
    "checkpoint-created",
    "pr-ready",
  ]

  const completed = new Set(nodes.map((n) => n.type))
  const lastCompleted = nodes.length > 0 ? nodes[nodes.length - 1].type : null

  if (lastCompleted) {
    const lastIdx = order.indexOf(lastCompleted)
    if (lastIdx >= 0 && lastIdx < order.length - 1) {
      const nextType = order[lastIdx + 1]
      if (!completed.has(nextType)) {
        nodes.push({
          id: `pending-${nextType}`,
          type: nextType,
          label: MILESTONE_META[nextType].icon + " " + capitalizeLabel(nextType),
          timestamp: 0,
          status: "pending",
          events: [],
          derived: true,
        })
      }
    }
  }
}

function capitalizeLabel(type: MilestoneType): string {
  const labels: Record<MilestoneType, string> = {
    baseline: "Baseline",
    "plan-accepted": "Plan accepted",
    "files-claimed": "Files claimed",
    "patch-applied": "Patch applied",
    "tests-failed": "Tests failed",
    "tests-passed": "Tests passed",
    "checkpoint-created": "Checkpoint created",
    "pr-ready": "PR ready",
  }
  return labels[type]
}

// ── Helpers ──

function formatTime(ts: number): string {
  if (!ts) return ""
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function formatDate(ts: number): string {
  if (!ts) return ""
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  })
}

function exportNodeData(node: MilestoneNode, sessionID: string): void {
  const data = {
    milestone: node.type,
    label: node.label,
    timestamp: node.timestamp,
    sessionID,
    eventCount: node.events.length,
    events: node.events.map((e) => ({
      id: e.id,
      type: e.type,
      tool: e.tool,
      file: e.file,
      status: e.status,
      timestamp: e.timestamp,
      error: e.error,
    })),
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `checkpoint-${node.type}-${node.timestamp}.json`
  a.click()
  URL.revokeObjectURL(url)

  showToast({
    title: "Checkpoint exported",
    description: `${node.label} data exported as JSON`,
    variant: "success",
  })
}

// ── Node Detail Component ──

function NodeDetail(props: { node: MilestoneNode }) {
  const node = () => props.node
  const events = () => props.node.events

  const fileCount = createMemo(() => {
    const files = new Set(
      events()
        .filter((e) => e.file)
        .map((e) => e.file!),
    )
    return files.size
  })

  const toolList = createMemo(() => {
    const tools = new Set(
      events()
        .filter((e) => e.tool)
        .map((e) => e.tool!),
    )
    return [...tools]
  })

  const errorList = createMemo(() => {
    return events()
      .filter((e) => e.error)
      .map((e) => e.error!)
  })

  return (
    <div class="flex flex-col gap-2 pt-2 pb-1">
      {/* Summary stats */}
      <div class="flex flex-wrap items-center gap-2">
        <Show when={events().length > 0}>
          <span class="text-[10px] text-text-muted bg-background-element px-1.5 py-0.5 rounded">
            {events().length} event{events().length !== 1 ? "s" : ""}
          </span>
        </Show>
        <Show when={fileCount() > 0}>
          <span class="text-[10px] text-text-muted bg-background-element px-1.5 py-0.5 rounded">
            {fileCount()} file{fileCount() !== 1 ? "s" : ""}
          </span>
        </Show>
        <Show when={toolList().length > 0}>
          <span class="text-[10px] text-text-muted bg-background-element px-1.5 py-0.5 rounded">
            {toolList().length} tool{toolList().length !== 1 ? "s" : ""}
          </span>
        </Show>
        <Show when={errorList().length > 0}>
          <span class="text-[10px] text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
            {errorList().length} error{errorList().length !== 1 ? "s" : ""}
          </span>
        </Show>
      </div>

      {/* File list */}
      <Show when={fileCount() > 0}>
        <div class="flex flex-col gap-0.5">
          <h5 class="text-[10px] text-text-muted uppercase tracking-wider">Files</h5>
          <div class="flex flex-col gap-0.5 max-h-20 overflow-y-auto">
            <For each={[...new Set(events().filter((e) => e.file).map((e) => e.file!))]}>
              {(file) => (
                <span class="text-[10px] font-mono text-text-muted truncate pl-1">
                  {file}
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Tool list */}
      <Show when={toolList().length > 0}>
        <div class="flex flex-col gap-0.5">
          <h5 class="text-[10px] text-text-muted uppercase tracking-wider">Tools</h5>
          <div class="flex flex-wrap gap-1">
            <For each={toolList()}>
              {(tool) => (
                <span class="text-[10px] font-mono text-text-muted bg-background-element px-1 py-0.5 rounded">
                  {tool}
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Errors */}
      <Show when={errorList().length > 0}>
        <div class="flex flex-col gap-0.5">
          <h5 class="text-[10px] text-red-400 uppercase tracking-wider">Errors</h5>
          <div class="flex flex-col gap-0.5 max-h-20 overflow-y-auto">
            <For each={errorList()}>
              {(err) => (
                <span class="text-[10px] font-mono text-red-400 truncate pl-1">⚠ {err}</span>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Event type breakdown */}
      <div class="flex flex-col gap-0.5">
        <h5 class="text-[10px] text-text-muted uppercase tracking-wider">Events</h5>
        <div class="flex flex-col gap-0.5 max-h-28 overflow-y-auto">
          <For each={events()}>
            {(event) => (
              <div class="flex items-center gap-1 text-[10px] font-mono text-text-muted">
                <span
                  class="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{
                    background:
                      event.status === "failed"
                        ? "#E74C3C"
                        : event.status === "succeeded"
                          ? "#2ECC71"
                          : event.status === "progress"
                            ? "#F1C40F"
                            : "#888",
                  }}
                />
                <span class="truncate">{event.type}</span>
                <Show when={event.tool}>
                  <span class="text-text-muted/60">({event.tool})</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>

      {/* Action buttons */}
      <div class="flex items-center gap-1.5 pt-1">
        <button
          class="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded border border-border text-text-muted hover:text-text hover:bg-background-menu transition-colors cursor-pointer"
          onClick={() => exportNodeData(node(), "")}
        >
          ⬇ Export
        </button>
      </div>
    </div>
  )
}

// ── Milestone Row Component ──

function MilestoneRow(props: {
  node: MilestoneNode
  isLast: boolean
  sessionID: string
}) {
  const [expanded, setExpanded] = createSignal(false)
  const node = () => props.node
  const meta = () => MILESTONE_META[node().type]
  const isPending = () => node().status === "pending"
  const isFailed = () => node().status === "failed"

  const labelColor = () => {
    if (isPending()) return "text-text-muted"
    if (isFailed()) return "text-red-400"
    return "text-text"
  }

  const timestampStr = () => {
    const ts = node().timestamp
    if (!ts) return ""
    const d = new Date(ts)
    const today = new Date()
    const isToday =
      d.getDate() === today.getDate() &&
      d.getMonth() === today.getMonth() &&
      d.getFullYear() === today.getFullYear()
    return isToday ? formatTime(ts) : `${formatDate(ts)} ${formatTime(ts)}`
  }

  const hasDetail = () => node().events.length > 0
  const statusDotColor = () => {
    if (isPending()) return "bg-border"
    if (isFailed()) return "bg-red-500"
    return "bg-emerald-500"
  }

  return (
    <div class="relative flex">
      {/* Timeline gutter */}
      <div class="flex flex-col items-center w-6 shrink-0">
        {/* Connector line above */}
        <Show when={!isPending()}>
          <div class="w-px h-2 bg-border" />
        </Show>

        {/* Dot */}
        <div
          class={[
            "w-3 h-3 rounded-full border-2 shrink-0 z-10 flex items-center justify-center",
            isPending()
              ? "border-border bg-background-element"
              : isFailed()
                ? "border-red-500 bg-red-500"
                : "border-emerald-500 bg-emerald-500",
          ].join(" ")}
        >
          <Show when={node().type === "checkpoint-created" && !isPending()}>
            <div class="w-1.5 h-1.5 rounded-full bg-white/60" />
          </Show>
        </div>

        {/* Connector line below */}
        <Show when={!props.isLast && !isPending()}>
          <div
            class={[
              "w-px flex-1 min-h-4",
              isFailed() ? "bg-red-500/30" : "bg-border",
            ].join(" ")}
          />
        </Show>
      </div>

      {/* Content */}
      <div class={["flex-1 min-w-0 pb-1 pl-2", isPending() ? "opacity-40" : ""].join(" ")}>
        <div class="flex items-center gap-1.5">
          {/* Status dot */}
          <div
            class={["w-1.5 h-1.5 rounded-full shrink-0", statusDotColor()].join(" ")}
          />

          {/* Label */}
          <span
            class={[
              "text-[11px] font-medium leading-tight",
              labelColor(),
            ].join(" ")}
          >
            {node().type === "checkpoint-created" && node().derived ? "⏺ " : ""}
            {meta()?.icon ?? ""} {node().label}
          </span>

          {/* Timestamp */}
          <Show when={timestampStr()}>
            <span class="text-[10px] text-text-muted/60 font-mono ml-auto">
              {timestampStr()}
            </span>
          </Show>

          {/* Expand toggle */}
          <Show when={hasDetail()}>
            <button
              class="text-[10px] text-text-muted hover:text-text transition-colors cursor-pointer ml-1"
              onClick={() => setExpanded(!expanded())}
            >
              {expanded() ? "▲" : "▼"}
            </button>
          </Show>
        </div>

        {/* Expanded detail */}
        <Show when={expanded() && hasDetail()}>
          <NodeDetail node={node()} />
        </Show>
      </div>
    </div>
  )
}

// ── Empty State ──

function EmptyState() {
  return (
    <div class="flex flex-col items-center justify-center h-48 gap-2 p-4 text-center">
      <div class="text-2xl">📊</div>
      <p class="text-xs text-text-muted">No checkpoint data available</p>
      <p class="text-[10px] text-text-muted max-w-48">
        Events will appear here as the session progresses. Each phase of work creates a
        timeline milestone.
      </p>
    </div>
  )
}

// ── Main Component ──

export function CheckpointTimeline() {
  const params = useParams()
  const { events, sessions } = useInspector()

  const activeSessionID = createMemo(() => {
    if (params.id) return params.id
    const allSessions = sessions()
    return allSessions.length > 0 ? allSessions[0] : null
  })

  const milestones = createMemo(() => {
    const sid = activeSessionID()
    if (!sid) return []
    return buildMilestones(events(), sid)
  })

  const sessionLabel = createMemo(() => {
    const sid = activeSessionID()
    if (!sid) return null
    return sid.length > 16 ? sid.slice(0, 16) + "…" : sid
  })

  return (
    <div class="flex flex-col h-full bg-background-base">
      {/* Header */}
      <div class="flex items-center gap-1.5 px-3 py-2 border-b border-border">
        <span class="text-xs">⏱</span>
        <span class="text-[11px] font-medium text-text">Checkpoint Timeline</span>
        <Show when={sessionLabel()}>
          <span class="text-[10px] text-text-muted font-mono ml-auto truncate">
            {sessionLabel()}
          </span>
        </Show>
        <Show when={milestones().length > 0}>
          <span class="text-[10px] text-text-muted ml-1">
            {milestones().length} milestone{milestones().length !== 1 ? "s" : ""}
          </span>
        </Show>
      </div>

      {/* Timeline */}
      <div class="flex-1 overflow-y-auto min-h-0">
        <Show
          when={milestones().length > 0}
          fallback={<EmptyState />}
        >
          {/* Session summary bar */}
          <div class="px-4 py-1.5 border-b border-border-weaker bg-background-element/50">
            <div class="flex items-center gap-2 text-[10px] text-text-muted">
              <span>
                ● {milestones().filter((m) => m.status === "completed").length} completed
              </span>
              <Show when={milestones().filter((m) => m.status === "failed").length > 0}>
                <span class="text-red-400">
                  ✕ {milestones().filter((m) => m.status === "failed").length} failed
                </span>
              </Show>
              <span class="text-text-muted/60">
                ○ {milestones().filter((m) => m.status === "pending").length} pending
              </span>
            </div>
          </div>

          {/* Milestone list */}
          <div class="px-3 py-3">
            <Index each={milestones()}>
              {(milestone, index) => (
                <MilestoneRow
                  node={milestone()}
                  isLast={index === milestones().length - 1}
                  sessionID={activeSessionID() ?? ""}
                />
              )}
            </Index>
          </div>
        </Show>
      </div>

      {/* Footer action */}
      <Show when={milestones().length > 0}>
        <div class="flex items-center gap-1.5 px-3 py-1.5 border-t border-border">
          <button
            class="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded border border-border text-text-muted hover:text-text hover:bg-background-menu transition-colors cursor-pointer"
            onClick={() => {
              const allData = milestones()
                .filter((m) => m.status !== "pending")
                .map((m) => ({
                  type: m.type,
                  label: m.label,
                  timestamp: m.timestamp,
                  status: m.status,
                  eventCount: m.events.length,
                  events: m.events.map((e) => ({
                    type: e.type,
                    tool: e.tool,
                    file: e.file,
                    status: e.status,
                  })),
                }))
              const blob = new Blob([JSON.stringify(allData, null, 2)], {
                type: "application/json",
              })
              const url = URL.createObjectURL(blob)
              const a = document.createElement("a")
              a.href = url
              a.download = `timeline-${activeSessionID()?.slice(0, 8) ?? "session"}.json`
              a.click()
              URL.revokeObjectURL(url)
              showToast({
                title: "Timeline exported",
                description: "Full checkpoint timeline exported as JSON",
                variant: "success",
              })
            }}
          >
            ⬇ Export All
          </button>
        </div>
      </Show>
    </div>
  )
}
