import { createMemo, createResource, createSignal, For, Show, type Component } from "solid-js"
import { useInspector, type RuntimeEvent } from "@/context/inspector"
import { useServerSDK } from "@/context/server-sdk"
import { useParams } from "@solidjs/router"
import { showToast } from "@tribunus/ui/toast"

// ── Types ──

export type DiffGroupKind = "file" | "turn" | "claim" | "phase"

export interface AgentDiffHunk {
  id: string
  file: string
  sessionID: string
  tool: string
  toolCallID: string
  phase: string
  turn: string
  claim: string
  risk: string
  tests: string[]
  diffSnippet: string
  editEvent: RuntimeEvent
  toolEvent: RuntimeEvent | null
  timestamp: number
}

export interface DiffFileGroup {
  file: string
  hunks: AgentDiffHunk[]
}

// ── Hunk derivation from event correlation ──

function phaseFromEvent(e: RuntimeEvent): string {
  return e.phase ?? classifyPhase(e.type)
}

function classifyPhase(type: string): string {
  if (type.includes("step.started") || type.includes("step.ended") || type.includes("tool")) return "execution"
  if (type.includes("text.") || type.includes("reasoning.") || type.includes("tool_input.")) return "plan"
  if (type.includes("shell.")) return "execution"
  if (type.includes("session.") || type.includes("server.")) return "lifecycle"
  return "unknown"
}

function claimFromEvent(e: RuntimeEvent): string {
  const raw = e.raw?.properties as Record<string, unknown> | undefined
  if (raw?.claim && typeof raw.claim === "string") return raw.claim
  if (e.actor) return `agent:${e.actor}`
  return "unclassified"
}

function turnFromEvent(e: RuntimeEvent): string {
  const raw = e.raw?.properties as Record<string, unknown> | undefined
  if (raw?.turnID && typeof raw.turnID === "string") return raw.turnID
  if (raw?.messageID && typeof raw.messageID === "string") return raw.messageID
  return `t:${e.sessionID}:${Math.floor(e.timestamp / 30000)}`
}

function riskFromHunk(file: string, tool: string, phase: string): string {
  if (phase === "execution" && (tool === "smart_bash" || tool === "bash")) return "high — live filesystem mutation"
  if (tool === "smart_write") return "medium — file overwrite"
  if (tool === "smart_batch") return "medium — multi-file edit"
  if (tool === "smart_sd") return "low — targeted search-replace"
  if (file.endsWith(".tsx") || file.endsWith(".ts")) return "low — type-checked file"
  return "medium — indirect change"
}

function testsForFile(file: string): string[] {
  const base = file.replace(/\.(ts|tsx)$/, "")
  return [
    `${base}.test.ts`,
    `${base}.test.tsx`,
    `${base}.spec.ts`,
    `${base}.spec.tsx`,
  ]
}

function deriveDiffHunks(events: RuntimeEvent[]): AgentDiffHunk[] {
  const editEvents = events.filter((e) => e.type === "file.edited")
  const toolEvents = events.filter((e) => e.category === "tool")
  const toolFileMap = new Map<string, RuntimeEvent[]>()

  for (const t of toolEvents) {
    const file = t.file
    if (!file) continue
    const list = toolFileMap.get(file)
    if (list) list.push(t)
    else toolFileMap.set(file, [t])
  }

  // Build parent-child lookup for event tree
  const childrenOf = new Map<string, RuntimeEvent[]>()
  for (const e of events) {
    if (!e.parentID) continue
    const list = childrenOf.get(e.parentID)
    if (list) list.push(e)
    else childrenOf.set(e.parentID, [e])
  }

  const hunks: AgentDiffHunk[] = []
  for (const edit of editEvents) {
    const file = edit.file ?? "unknown"
    const toolCandidates = toolFileMap.get(file) ?? []
    const nearestTool = toolCandidates
      .filter((t) => Math.abs(t.timestamp - edit.timestamp) < 60000)
      .sort((a, b) => Math.abs(a.timestamp - edit.timestamp) - Math.abs(b.timestamp - edit.timestamp))[0] ?? null

    const phase = phaseFromEvent(edit)
    const tool = edit.tool ?? nearestTool?.tool ?? "unknown"
    const risk = riskFromHunk(file, tool, phase)
    const tests = testsForFile(file)
    const claim = claimFromEvent(edit)
    const turn = turnFromEvent(edit)

    const rawProps = edit.raw?.properties as Record<string, unknown> | undefined
    const diffSnippet = rawProps?.diff
      ? String(rawProps.diff).slice(0, 200)
      : rawProps?.summary
        ? String(rawProps.summary).slice(0, 200)
        : `Edited ${file}`

    hunks.push({
      id: edit.id,
      file,
      sessionID: edit.sessionID,
      tool,
      toolCallID: nearestTool?.id ?? edit.id,
      phase,
      turn,
      claim,
      risk,
      tests,
      diffSnippet,
      editEvent: edit,
      toolEvent: nearestTool,
      timestamp: edit.timestamp,
    })
  }

  return hunks.sort((a, b) => b.timestamp - a.timestamp)
}

function groupHunksByFile(hunks: AgentDiffHunk[]): DiffFileGroup[] {
  const map = new Map<string, AgentDiffHunk[]>()
  for (const h of hunks) {
    const list = map.get(h.file)
    if (list) list.push(h)
    else map.set(h.file, [h])
  }
  return [...map.entries()]
    .map(([file, hunks]) => ({ file, hunks }))
    .sort((a, b) => a.file.localeCompare(b.file))
}

function groupHunksByTurn(hunks: AgentDiffHunk[]): Map<string, AgentDiffHunk[]> {
  const map = new Map<string, AgentDiffHunk[]>()
  for (const h of hunks) {
    const list = map.get(h.turn)
    if (list) list.push(h)
    else map.set(h.turn, [h])
  }
  return map
}

function groupHunksByClaim(hunks: AgentDiffHunk[]): Map<string, AgentDiffHunk[]> {
  const map = new Map<string, AgentDiffHunk[]>()
  for (const h of hunks) {
    const list = map.get(h.claim)
    if (list) list.push(h)
    else map.set(h.claim, [h])
  }
  return map
}

function groupHunksByPhase(hunks: AgentDiffHunk[]): Map<string, AgentDiffHunk[]> {
  const map = new Map<string, AgentDiffHunk[]>()
  for (const h of hunks) {
    const list = map.get(h.phase)
    if (list) list.push(h)
    else map.set(h.phase, [h])
  }
  return map
}

// ── Revert through SDK ──

async function revertHunk(hunk: AgentDiffHunk) {
  const dir = hunk.sessionID
  const msgID = hunk.editEvent.raw?.id
  try {
    // Use the v1 session revert endpoint which takes a sessionID and messageID
    const resp = await fetch(`/api/session/${dir}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageID: msgID }),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => "unknown error")
      throw new Error(text)
    }
    showToast({
      title: "Hunk reverted",
      description: `${hunk.file} — ${hunk.diffSnippet.slice(0, 80)}`,
      variant: "success",
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    showToast({
      title: "Revert failed",
      description: message,
      variant: "error",
    })
  }
}

async function fetchHunkExplanation(hunk: AgentDiffHunk): Promise<string> {
  const sessionID = hunk.sessionID
  const editID = hunk.editEvent.id
  const toolID = hunk.toolEvent?.id

  const context: string[] = [
    `File: ${hunk.file}`,
    `Change: ${hunk.diffSnippet}`,
    `Tool: ${hunk.tool}`,
    `Phase: ${hunk.phase}`,
    `Turn: ${hunk.turn}`,
    `Risk: ${hunk.risk}`,
  ]
  if (toolID) {
    context.push(`Tool Call ID: ${toolID}`)
  }

  // In production this would call the event ledger API.
  // For now, reconstruct context from the in-memory events.
  return context.join("\n")
}

// ── Sub-components ──

function RiskBadge(props: { risk: string }) {
  const color = () => {
    if (props.risk.startsWith("high")) return "bg-red-500/10 text-red-400 border-red-500/30"
    if (props.risk.startsWith("medium")) return "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
    return "bg-green-500/10 text-green-400 border-green-500/30"
  }
  return (
    <span
      class={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${color()}`}
    >
      {props.risk}
    </span>
  )
}

function ToolBadge(props: { tool: string }) {
  return (
    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/30">
      🔧 {props.tool}
    </span>
  )
}

function PhaseBadge(props: { phase: string }) {
  const colorMap: Record<string, string> = {
    execution: "bg-purple-500/10 text-purple-400 border-purple-500/30",
    plan: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
    lifecycle: "bg-gray-500/10 text-gray-400 border-gray-500/30",
  }
  const cls = colorMap[props.phase] ?? "bg-gray-500/10 text-gray-400 border-gray-500/30"
  return (
    <span class={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {props.phase}
    </span>
  )
}

function ClaimBadge(props: { claim: string }) {
  return (
    <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border border-orange-500/30 bg-orange-500/10 text-orange-400">
      🏷 {props.claim.slice(0, 32)}
    </span>
  )
}

// ── HunkExplanation ──

export const HunkExplanation: Component<{
  hunk: AgentDiffHunk
  onClose: () => void
}> = (props) => {
  const [context] = createResource(() => props.hunk, fetchHunkExplanation)

  return (
    <div class="border border-border rounded bg-background-element p-3 space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-text">📋 Event Ledger Context</span>
        <button
          class="text-text-muted hover:text-text transition-colors text-sm leading-none"
          onClick={props.onClose}
        >
          ✕
        </button>
      </div>
      <div class="space-y-1 text-[11px] text-text-muted">
        <Show when={context()} fallback={<span class="italic">Loading context...</span>}>
          <For each={context()!.split("\n")}>
            {(line) => <div class="font-mono">{line}</div>}
          </For>
        </Show>
      </div>
      <Show when={context.error}>
        <div class="text-[11px] text-red-400">Failed to load context: {context.error?.message}</div>
      </Show>
    </div>
  )
}

// ── DiffHunk ──

export const DiffHunk: Component<{
  hunk: AgentDiffHunk
  onRevert: (h: AgentDiffHunk) => void
  reverting: boolean
}> = (props) => {
  const [showExplanation, setShowExplanation] = createSignal(false)
  const [explaining, setExplaining] = createSignal(false)

  return (
    <div class="border border-border rounded bg-background-base hover:border-border-hover transition-colors">
      {/* Hunk header */}
      <div class="flex items-center gap-2 px-2.5 py-1.5 border-b border-border bg-background-element/50">
        <div class="flex items-center gap-1.5 flex-1 min-w-0">
          <ToolBadge tool={props.hunk.tool} />
          <PhaseBadge phase={props.hunk.phase} />
          <ClaimBadge claim={props.hunk.claim} />
          <RiskBadge risk={props.hunk.risk} />
        </div>
        <span class="text-[10px] text-text-muted shrink-0">
          {new Date(props.hunk.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {/* Hunk body */}
      <div class="px-2.5 py-2 space-y-2">
        {/* Diff snippet */}
        <pre class="text-[11px] font-mono text-text bg-background-element/30 rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-24">
          {props.hunk.diffSnippet}
        </pre>

        {/* Metadata row */}
        <div class="flex items-center gap-3 text-[10px] text-text-muted">
          <span>Session: {props.hunk.sessionID.slice(0, 12)}</span>
          <span>Turn: {props.hunk.turn.slice(0, 16)}</span>
        </div>

        {/* Tests */}
        <div class="flex flex-wrap gap-1">
          <span class="text-[10px] text-text-muted">Tests:</span>
          <For each={props.hunk.tests}>
            {(test) => (
              <span class="text-[10px] font-mono px-1 py-0.5 rounded bg-green-500/5 text-green-400 border border-green-500/20">
                {test}
              </span>
            )}
          </For>
        </div>

        {/* Actions */}
        <div class="flex items-center gap-2">
          <button
            class="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => props.onRevert(props.hunk)}
            disabled={props.reverting}
          >
            {props.reverting ? "⏳ Reverting..." : "↩ Revert"}
          </button>

          <button
            class="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border border-border text-text-muted hover:text-text hover:bg-background-element/50 transition-colors"
            onClick={() => {
              setExplaining(true)
              setShowExplanation(!showExplanation())
            }}
          >
            {showExplanation() ? "△ Close" : "ℹ Explain this hunk"}
          </button>
        </div>

        <Show when={showExplanation() && explaining()}>
          <HunkExplanation hunk={props.hunk} onClose={() => setShowExplanation(false)} />
        </Show>
      </div>
    </div>
  )
}

// ── DiffFileGroup ──

export const DiffFileGroup: Component<{
  group: DiffFileGroup
  onRevert: (h: AgentDiffHunk) => void
  reverting: boolean
  collapsed: boolean
  onToggle: () => void
}> = (props) => {
  return (
    <div class="space-y-1">
      {/* File header */}
      <div class="flex items-center gap-2 px-2 py-1.5 rounded bg-background-element border border-border cursor-pointer hover:bg-background-element/80 transition-colors" onClick={props.onToggle}>
        <span class="text-xs text-text-muted transition-transform" classList={{ "rotate-90": !props.collapsed }}>
          ▶
        </span>
        <span class="flex-1 text-xs font-medium text-text truncate font-mono">{props.group.file}</span>
        <span class="text-[10px] text-text-muted bg-background-base px-1.5 py-0.5 rounded">
          {props.group.hunks.length} {props.group.hunks.length === 1 ? "hunk" : "hunks"}
        </span>
        <button
          class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            for (const h of props.group.hunks) props.onRevert(h)
          }}
        >
          ↩ All
        </button>
      </div>

      {/* Hunks */}
      <Show when={!props.collapsed}>
        <div class="ml-3 space-y-1.5 pl-2 border-l-2 border-border">
          <For each={props.group.hunks}>
            {(hunk) => <DiffHunk hunk={hunk} onRevert={props.onRevert} reverting={props.reverting} />}
          </For>
        </div>
      </Show>
    </div>
  )
}

// ── GroupPanel ──

function GroupPanel(props: {
  label: string
  groups: [string, AgentDiffHunk[]][]
  onRevert: (h: AgentDiffHunk) => void
  reverting: boolean
}) {
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set())

  return (
    <div class="space-y-1">
      <For each={props.groups}>
        {([key, hunks]) => (
          <div class="space-y-1">
            {/* Group header */}
            <div
              class="flex items-center gap-2 px-2 py-1.5 rounded bg-background-element/50 border border-border cursor-pointer hover:bg-background-element/80 transition-colors"
              onClick={() => {
                const s = new Set(collapsed())
                if (s.has(key)) s.delete(key)
                else s.add(key)
                setCollapsed(s)
              }}
            >
              <span class="text-xs text-text-muted transition-transform" classList={{ "rotate-90": !collapsed().has(key) }}>
                ▶
              </span>
              <span class="flex-1 text-xs font-medium text-text truncate">{props.label}: {key}</span>
              <span class="text-[10px] text-text-muted bg-background-base px-1.5 py-0.5 rounded">
                {hunks.length} {hunks.length === 1 ? "hunk" : "hunks"}
              </span>
              <button
                class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  for (const h of hunks) props.onRevert(h)
                }}
              >
                ↩ All
              </button>
            </div>

            {/* Hunks */}
            <Show when={!collapsed().has(key)}>
              <div class="ml-3 space-y-1.5 pl-2 border-l-2 border-border">
                <For each={hunks}>
                  {(hunk) => <DiffHunk hunk={hunk} onRevert={props.onRevert} reverting={props.reverting} />}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}

// ── Main component ──

export function AgentDiffReview() {
  const { events } = useInspector()
  const [groupKind, setGroupKind] = createSignal<DiffGroupKind>("file")
  const [searchQuery, setSearchQuery] = createSignal("")
  const [reverting, setReverting] = createSignal(false)

  const allHunks = createMemo(() => deriveDiffHunks(events()))

  const filteredHunks = createMemo(() => {
    const q = searchQuery().toLowerCase()
    if (!q) return allHunks()
    return allHunks().filter(
      (h) =>
        h.file.toLowerCase().includes(q) ||
        h.tool.toLowerCase().includes(q) ||
        h.phase.toLowerCase().includes(q) ||
        h.claim.toLowerCase().includes(q) ||
        h.diffSnippet.toLowerCase().includes(q),
    )
  })

  const groups = createMemo(() => {
    const kind = groupKind()
    const hunks = filteredHunks()
    if (kind === "file") {
      return {
        label: "File",
        entries: groupHunksByFile(hunks).map((g) => [g.file, g.hunks] as [string, AgentDiffHunk[]]),
      }
    }
    if (kind === "turn") {
      const m = groupHunksByTurn(hunks)
      return { label: "Turn", entries: [...m.entries()] }
    }
    if (kind === "claim") {
      const m = groupHunksByClaim(hunks)
      return { label: "Claim", entries: [...m.entries()] }
    }
    const m = groupHunksByPhase(hunks)
    return { label: "Phase", entries: [...m.entries()] }
  })

  const stats = createMemo(() => ({
    total: filteredHunks().length,
    files: new Set(filteredHunks().map((h) => h.file)).size,
    tools: new Set(filteredHunks().map((h) => h.tool)).size,
    phases: new Set(filteredHunks().map((h) => h.phase)).size,
  }))

  const handleRevert = async (hunk: AgentDiffHunk) => {
    setReverting(true)
    try {
      await revertHunk(hunk)
    } finally {
      setReverting(false)
    }
  }

  return (
    <div class="flex flex-col h-full">
      {/* Toolbar */}
      <div class="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <div class="flex items-center gap-1">
          <span class="text-[10px] text-text-muted">Group by:</span>
          {(["file", "turn", "claim", "phase"] as const).map((kind) => (
            <button
              class={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                groupKind() === kind
                  ? "bg-accent text-white border-accent"
                  : "bg-background-element text-text-muted border-border hover:text-text hover:border-border-hover"
              }`}
              onClick={() => setGroupKind(kind)}
            >
              {kind}
            </button>
          ))}
        </div>

        <div class="flex-1" />

        <input
          type="text"
          placeholder="Search files, tools, phases…"
          class="w-48 px-2 py-0.5 rounded text-[11px] bg-background-element border border-border text-text placeholder-text-muted focus:outline-none focus:border-accent"
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />
      </div>

      {/* Stats bar */}
      <div class="flex items-center gap-3 px-3 py-1 border-b border-border shrink-0 text-[10px] text-text-muted">
        <span>{stats().total} changes</span>
        <span>{stats().files} files</span>
        <span>{stats().tools} tools</span>
        <span>{stats().phases} phases</span>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto p-3 space-y-2">
        <Show
          when={groups().entries.length > 0}
          fallback={
            <div class="flex flex-col items-center justify-center h-full text-text-muted gap-2">
              <span class="text-2xl">📝</span>
              <p class="text-xs">No file edits detected yet</p>
              <p class="text-[10px]">Edits will appear here as the agent makes changes</p>
            </div>
          }
        >
          <GroupPanel
            label={groups().label}
            groups={groups().entries}
            onRevert={handleRevert}
            reverting={reverting()}
          />
        </Show>
      </div>
    </div>
  )
}
