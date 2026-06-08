import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Collapsible } from "@tribunus/ui/collapsible"
import { Icon } from "@tribunus/ui/icon"

// ── Types ──

export interface ClaimInfo {
  taskId: string
  sessionId: string
  wave: number
  waveType: string
  subagentType: string
  description: string
  status: string
  createdAt: number
  releasedAt?: number
}

export interface TreeNode {
  path: string
  name: string
  type: "file" | "directory"
  status: ClaimStatus
  claim?: ClaimInfo
  children?: TreeNode[]
}

export type ClaimStatus =
  | "unclaimed"
  | "claimed_by_current"
  | "claimed_by_other"
  | "readonly"
  | "protected"
  | "stale"
  | "conflict"
  | "released"

// ── Constants ──

const STATUS_LABELS: Record<ClaimStatus, string> = {
  unclaimed: "Unclaimed",
  claimed_by_current: "Claimed by current",
  claimed_by_other: "Claimed by other",
  readonly: "Read-only",
  protected: "Protected",
  stale: "Stale claim",
  conflict: "Conflict",
  released: "Released",
}

const STATUS_COLORS: Record<ClaimStatus, { fill: string; stroke: string; text: string; dot: string }> = {
  unclaimed: { fill: "bg-transparent", stroke: "border-border-weaker-base", text: "text-text-muted", dot: "#888" },
  claimed_by_current: { fill: "bg-green-500/8", stroke: "border-green-500/30", text: "text-green-400", dot: "#22c55e" },
  claimed_by_other: { fill: "bg-blue-500/8", stroke: "border-blue-500/30", text: "text-blue-400", dot: "#3b82f6" },
  readonly: { fill: "bg-purple-500/8", stroke: "border-purple-500/30", text: "text-purple-400", dot: "#a855f7" },
  protected: { fill: "bg-orange-500/8", stroke: "border-orange-500/30", text: "text-orange-400", dot: "#f97316" },
  stale: { fill: "bg-yellow-500/8", stroke: "border-yellow-500/30", text: "text-yellow-400", dot: "#eab308" },
  conflict: { fill: "bg-red-500/8", stroke: "border-red-500/30", text: "text-red-400", dot: "#ef4444" },
  released: { fill: "bg-gray-500/5", stroke: "border-gray-500/20", text: "text-gray-400", dot: "#6b7280" },
}

const LEGEND_ITEMS: Array<{ status: ClaimStatus }> = [
  { status: "claimed_by_current" },
  { status: "claimed_by_other" },
  { status: "readonly" },
  { status: "protected" },
  { status: "stale" },
  { status: "conflict" },
  { status: "released" },
]

// ── Helpers ──

function formatTime(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function currentSessionId(): string | null {
  try {
    const match = window.location.pathname.match(/\/session\/([^/]+)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

// ── Component ──

export function ClaimsMap(props: {
  sessionId?: string
  treeData?: TreeNode[]
}) {
  const [selectedFile, setSelectedFile] = createSignal<TreeNode | null>(null)
  const [statusFilter, setStatusFilter] = createSignal<Set<ClaimStatus>>(new Set())
  const [showLegend, setShowLegend] = createSignal(true)
  const currentSession = () => props.sessionId ?? currentSessionId() ?? ""

  // Fetch tree from API if no explicit tree data provided
  const [treeResource] = createResource(
    () => props.sessionId,
    async (sessionId) => {
      const base = typeof window !== "undefined" ? window.location.origin : ""
      const res = await fetch(`${base}/api/claims/tree?sessionId=${encodeURIComponent(sessionId)}`)
      if (!res.ok) throw new Error("Failed to fetch claims tree")
      const data = (await res.json()) as { nodes: TreeNode[] }
      return data.nodes
    },
  )

  const nodes = createMemo(() => props.treeData ?? treeResource() ?? [])

  const filteredNodes = createMemo(() => {
    const filter = statusFilter()
    if (filter.size === 0) return nodes()
    return filterTree(nodes(), filter)
  })

  function filterTree(tree: TreeNode[], filter: Set<ClaimStatus>): TreeNode[] {
    return tree
      .map((node) => {
        if (node.type === "directory") {
          const children = filterTree(node.children ?? [], filter)
          if (children.length > 0) {
            return { ...node, children }
          }
          // Keep directory if it matches the filter itself
          if (filter.has(node.status)) return node
          return null
        }
        return filter.has(node.status) ? node : null
      })
      .filter(Boolean) as TreeNode[]
  }

  function toggleFilter(status: ClaimStatus) {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  function releaseClaim(taskId: string) {
    // Would call API to release the claim
    setSelectedFile(null)
  }

  // ── Empty state ──
  if (nodes().length === 0 && !treeResource.loading) {
    return (
      <div class="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
        <Icon name="branch" class="w-8 h-8 text-text-muted" />
        <div class="text-sm text-text-muted">No active claims</div>
        <div class="text-xs text-text-weak max-w-[240px]">
          Files with active coordination claims will appear here.
        </div>
      </div>
    )
  }

  // ── Loading state ──
  if (treeResource.loading) {
    return (
      <div class="flex items-center justify-center h-full">
        <div class="flex items-center gap-2 text-xs text-text-muted">
          <span class="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          Loading claims map...
        </div>
      </div>
    )
  }

  return (
    <div class="flex flex-col h-full">
      {/* Filter bar */}
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background-element">
        <button
          onClick={() => setShowLegend(!showLegend())}
          class="text-[11px] text-text-muted hover:text-text transition-colors flex items-center gap-1"
        >
          <Icon name={showLegend() ? "chevron-down" : "chevron-right"} class="w-3 h-3" />
          Legend
        </button>
        <div class="flex-1" />
        <span class="text-[10px] text-text-muted">
          {nodes().length} {nodes().length === 1 ? "node" : "nodes"}
        </span>
      </div>

      {/* Legend (collapsible) */}
      <Show when={showLegend()}>
        <div class="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-border-weaker-base bg-background-base">
          <For each={LEGEND_ITEMS}>
            {(item) => {
              const colors = STATUS_COLORS[item.status]
              const isActive = statusFilter().has(item.status)
              return (
                <button
                  onClick={() => toggleFilter(item.status)}
                  class="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border transition-colors"
                  classList={{
                    [colors.fill]: true,
                    [colors.stroke]: !isActive,
                    "border-text-muted": isActive,
                  }}
                >
                  <span
                    class="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ "background-color": colors.dot }}
                  />
                  <span class={colors.text}>{STATUS_LABELS[item.status]}</span>
                  <Show when={isActive}>
                    <Icon name="close" class="w-2.5 h-2.5 ml-0.5" />
                  </Show>
                </button>
              )
            }}
          </For>
          <Show when={statusFilter().size > 0}>
            <button
              onClick={() => setStatusFilter(new Set())}
              class="text-[10px] text-text-muted hover:text-text ml-1"
            >
              Clear
            </button>
          </Show>
        </div>
      </Show>

      {/* Tree / Main content area */}
      <div class="flex flex-1 min-h-0">
        {/* Tree panel */}
        <div class="flex-1 overflow-y-auto overflow-x-hidden">
          <For each={filteredNodes()}>
            {(node) => (
              <TreeNodeRow
                node={node}
                depth={0}
                currentSession={currentSession()}
                onSelect={setSelectedFile}
              />
            )}
          </For>
          <Show when={filteredNodes().length === 0 && nodes().length > 0}>
            <div class="flex items-center justify-center h-full text-xs text-text-muted p-8">
              No nodes match the selected filters
            </div>
          </Show>
        </div>

        {/* Detail panel (side) */}
        <Show when={selectedFile()}>
          {(file) => (
            <div class="w-64 shrink-0 border-l border-border bg-background-element overflow-y-auto">
              <ClaimDetailPanel
                node={file()}
                isOwned={file().claim?.sessionId === currentSession()}
                onRelease={releaseClaim}
                onClose={() => setSelectedFile(null)}
              />
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

// ── Tree Node Row ──

function TreeNodeRow(props: {
  node: TreeNode
  depth: number
  currentSession: string
  onSelect: (node: TreeNode) => void
}) {
  const [expanded, setExpanded] = createSignal(props.depth < 1)
  const colors = () => STATUS_COLORS[props.node.status]

  return (
    <div>
      <div
        class="flex items-center gap-1 px-2 py-1 text-xs hover:bg-background-menu transition-colors cursor-pointer border-l-2"
        style={{
          "padding-left": `${12 + props.depth * 16}px`,
          "border-left-color": props.node.status !== "unclaimed" ? colors().dot : "transparent",
        }}
        classList={{
          [colors().fill]: true,
        }}
        onClick={() => {
          if (props.node.type === "directory") {
            setExpanded(!expanded())
          } else {
            props.onSelect(props.node)
          }
        }}
      >
        {/* Expand/collapse */}
        <Show when={props.node.type === "directory"}>
          <button
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(!expanded())
            }}
            class="w-4 h-4 flex items-center justify-center shrink-0 text-text-muted hover:text-text"
          >
            <Icon name={expanded() ? "chevron-down" : "chevron-right"} class="w-3 h-3" />
          </button>
        </Show>

        {/* Status dot */}
        <span
          class="w-2 h-2 rounded-full shrink-0"
          style={{ "background-color": colors().dot }}
        />

        {/* Icon */}
        <Icon
          name={props.node.type === "directory" ? "folder" : "file-tree"}
          class="w-3.5 h-3.5 shrink-0"
          classList={{
            "text-yellow-400": props.node.type === "directory",
            [colors().text]: props.node.type === "file",
          }}
        />

        {/* Name */}
        <span class="truncate text-text">{props.node.name}</span>

        {/* Stale badge */}
        <Show when={props.node.status === "stale"}>
          <span class="text-[9px] px-1 rounded bg-yellow-500/15 text-yellow-400 ml-auto shrink-0">
            stale
          </span>
        </Show>

        {/* Conflict badge */}
        <Show when={props.node.status === "conflict"}>
          <span class="text-[9px] px-1 rounded bg-red-500/15 text-red-400 ml-auto shrink-0">
            conflict
          </span>
        </Show>

        {/* Claimed by me badge */}
        <Show when={props.node.claim?.sessionId === props.currentSession && props.node.status === "claimed_by_current"}>
          <span class="text-[9px] px-1 rounded bg-green-500/15 text-green-400 ml-auto shrink-0">
            me
          </span>
        </Show>

        {/* Released badge */}
        <Show when={props.node.status === "released"}>
          <span class="text-[9px] px-1 rounded bg-gray-500/15 text-gray-400 ml-auto shrink-0">
            released
          </span>
        </Show>
      </div>

      {/* Children */}
      <Show when={props.node.type === "directory" && expanded() && props.node.children}>
        <For each={props.node.children}>
          {(child) => (
            <TreeNodeRow
              node={child}
              depth={props.depth + 1}
              currentSession={props.currentSession}
              onSelect={props.onSelect}
            />
          )}
        </For>
      </Show>
    </div>
  )
}

// ── Claim Detail Panel ──

function ClaimDetailPanel(props: {
  node: TreeNode
  isOwned: boolean
  onRelease: (taskId: string) => void
  onClose: () => void
}) {
  const claim = () => props.node.claim

  return (
    <div class="flex flex-col h-full">
      {/* Header */}
      <div class="flex items-center justify-between px-3 py-2 border-b border-border">
        <span class="text-xs font-medium text-text">Claim Details</span>
        <button
          onClick={props.onClose}
          class="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text hover:bg-background-menu transition-colors"
        >
          <Icon name="close" class="w-3 h-3" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-3 space-y-3">
        {/* File path */}
        <div>
          <div class="text-[10px] text-text-muted uppercase tracking-wider mb-1">File</div>
          <div class="text-xs text-text break-all">{props.node.path}</div>
        </div>

        {/* Status */}
        <div>
          <div class="text-[10px] text-text-muted uppercase tracking-wider mb-1">Status</div>
          <div class="flex items-center gap-1.5">
            <span
              class="w-2 h-2 rounded-full"
              style={{ "background-color": STATUS_COLORS[props.node.status].dot }}
            />
            <span class={`text-xs font-medium ${STATUS_COLORS[props.node.status].text}`}>
              {STATUS_LABELS[props.node.status]}
            </span>
          </div>
        </div>

        <Show when={claim()}>
          {(c) => (
            <>
              {/* Owner */}
              <div>
                <div class="text-[10px] text-text-muted uppercase tracking-wider mb-1">Owner</div>
                <div class="text-xs text-text font-mono">{c().sessionId}</div>
              </div>

              {/* Claimed at */}
              <div>
                <div class="text-[10px] text-text-muted uppercase tracking-wider mb-1">Claimed</div>
                <div class="text-xs text-text">{formatTime(c().createdAt)}</div>
              </div>

              {/* Released at */}
              <Show when={c().releasedAt}>
                {(releasedAt) => (
                  <div>
                    <div class="text-[10px] text-text-muted uppercase tracking-wider mb-1">Released</div>
                    <div class="text-xs text-text">{formatTime(releasedAt())}</div>
                  </div>
                )}
              </Show>

              {/* Agent type */}
              <div>
                <div class="text-[10px] text-text-muted uppercase tracking-wider mb-1">Agent</div>
                <div class="text-xs text-text">{c().subagentType}</div>
              </div>

              {/* Wave */}
              <div>
                <div class="text-[10px] text-text-muted uppercase tracking-wider mb-1">Wave</div>
                <div class="text-xs text-text">
                  {c().waveType} #{c().wave}
                </div>
              </div>

              {/* Description */}
              <Show when={c().description}>
                <div>
                  <div class="text-[10px] text-text-muted uppercase tracking-wider mb-1">Description</div>
                  <div class="text-xs text-text-muted">{c().description}</div>
                </div>
              </Show>

              {/* Task ID */}
              <div>
                <div class="text-[10px] text-text-muted uppercase tracking-wider mb-1">Task ID</div>
                <div class="text-xs text-text-muted font-mono break-all">{c().taskId}</div>
              </div>
            </>
          )}
        </Show>

        {/* Result (if released with result) */}
        <Show when={claim()?.status === "released" && claim()?.description}>
          <div>
            <div class="text-[10px] text-text-muted uppercase tracking-wider mb-1">Result</div>
            <div class="text-xs text-text-muted">{claim()?.taskId}</div>
          </div>
        </Show>
      </div>

      {/* Actions footer */}
      <Show when={props.isOwned && props.node.status !== "released"}>
        <div class="px-3 py-2 border-t border-border">
          <button
            onClick={() => props.node.claim && props.onRelease(props.node.claim.taskId)}
            class="w-full px-3 py-1.5 text-xs font-medium rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors border border-red-500/20"
          >
            <Icon name="reset" class="w-3 h-3 inline-block mr-1" />
            Release Claim
          </button>
        </div>
      </Show>
    </div>
  )
}
