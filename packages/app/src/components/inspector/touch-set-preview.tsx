import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Icon } from "@tribunus/ui/icon"
import { Tag } from "@tribunus/ui/tag"

// ── Types ──

export interface TouchSetFile {
  path: string
  operation: "read" | "modify" | "create" | "delete" | "protect"
  reason: string
  riskLevel: "low" | "medium" | "high"
  associatedTests: string[]
}

export type FileApproval = "pending" | "approved" | "readonly" | "denied"

// ── Constants ──

const OPERATION_LABELS: Record<TouchSetFile["operation"], { icon: string; label: string }> = {
  read: { icon: "magnifying-glass", label: "Read" },
  modify: { icon: "edit", label: "Modify" },
  create: { icon: "plus-small", label: "Create" },
  delete: { icon: "close", label: "Delete" },
  protect: { icon: "shield", label: "Protect" },
}

const RISK_COLORS: Record<TouchSetFile["riskLevel"], string> = {
  low: "bg-green-500/15 text-green-400 border-green-500/30",
  medium: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  high: "bg-red-500/15 text-red-400 border-red-500/30",
}

const STATUS_COLORS: Record<string, string> = {
  pending: "text-text-muted",
  approved: "text-green-400",
  readonly: "text-blue-400",
  denied: "text-red-400",
}

// ── Component ──

export function TouchSetPreview(props: {
  files?: TouchSetFile[]
  sessionId?: string
}) {
  const [approvals, setApprovals] = createSignal<Record<string, FileApproval>>({})
  const [selectMode, setSelectMode] = createSignal<"none" | "select">("none")
  const [selectedPaths, setSelectedPaths] = createSignal<Set<string>>(new Set())

  // Fetch claims from API if sessionId provided
  const [claimsData] = createResource(
    () => props.sessionId,
    async (sessionId) => {
      const base = typeof window !== "undefined" ? window.location.origin : ""
      const res = await fetch(`${base}/api/claims?sessionId=${encodeURIComponent(sessionId)}`)
      if (!res.ok) throw new Error("Failed to fetch claims")
      return res.json() as Promise<{ claims: any[]; reservations: any[] }>
    },
  )

  // Build touch set from claims data if no explicit files provided
  const touchFiles = createMemo((): TouchSetFile[] => {
    if (props.files) return props.files
    const data = claimsData()
    if (!data) return []

    // Derive TouchSetFile entries from reservations + claims
    const files: TouchSetFile[] = []
    for (const res of data.reservations) {
      const claim = data.claims.find((c) => c.taskId === res.taskId)
      files.push({
        path: res.path,
        operation: "modify",
        reason: claim?.description ?? `Reserved by ${res.sessionId}`,
        riskLevel: "medium",
        associatedTests: [],
      })
    }
    return files
  })

  const approvalCount = createMemo(() => {
    const a = approvals()
    return {
      total: touchFiles().length,
      approved: Object.values(a).filter((v) => v === "approved").length,
      readonly: Object.values(a).filter((v) => v === "readonly").length,
      denied: Object.values(a).filter((v) => v === "denied").length,
      pending: touchFiles().length - Object.keys(a).length,
    }
  })

  function setFileStatus(path: string, status: FileApproval) {
    setApprovals((prev) => ({ ...prev, [path]: status }))
  }

  function approveAll() {
    const all: Record<string, FileApproval> = {}
    for (const f of touchFiles()) {
      all[f.path] = "approved"
    }
    setApprovals(all)
  }

  function approveSelected() {
    const sel = selectedPaths()
    setApprovals((prev) => {
      const next = { ...prev }
      for (const path of sel) {
        next[path] = "approved"
      }
      return next
    })
    setSelectedPaths(new Set<string>())
  }

  function toggleSelect(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // ── Empty state ──
  if (touchFiles().length === 0 && !claimsData.loading) {
    return (
      <div class="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
        <Icon name="archive" class="w-8 h-8 text-text-muted" />
        <div class="text-sm text-text-muted">No files in touch set</div>
        <div class="text-xs text-text-weak max-w-[240px]">
          Files will appear here when the agent plans file operations.
        </div>
      </div>
    )
  }

  // ── Loading state ──
  if (claimsData.loading) {
    return (
      <div class="flex items-center justify-center h-full">
        <div class="flex items-center gap-2 text-xs text-text-muted">
          <span class="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          Loading touch set...
        </div>
      </div>
    )
  }

  return (
    <div class="flex flex-col h-full">
      {/* Header / Summary bar */}
      <div class="flex items-center justify-between px-3 py-2 border-b border-border bg-background-element">
        <div class="flex items-center gap-3 text-xs">
          <span class="text-text font-medium">{approvalCount().total} files</span>
          <span class="text-green-400">{approvalCount().approved} approved</span>
          <Show when={approvalCount().readonly > 0}>
            <span class="text-blue-400">{approvalCount().readonly} read-only</span>
          </Show>
          <Show when={approvalCount().denied > 0}>
            <span class="text-red-400">{approvalCount().denied} denied</span>
          </Show>
          <Show when={approvalCount().pending > 0}>
            <span class="text-text-muted">{approvalCount().pending} pending</span>
          </Show>
        </div>
      </div>

      {/* Action toolbar */}
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border-weaker-base bg-background-base">
        <button
          onClick={approveAll}
          class="px-2 py-1 text-[11px] font-medium rounded bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors border border-green-500/20"
        >
          <Icon name="circle-check" class="w-3 h-3 inline-block mr-1" />
          Approve All
        </button>

        <Show when={selectMode() === "select"}>
          <button
            onClick={approveSelected}
            disabled={selectedPaths().size === 0}
            class="px-2 py-1 text-[11px] font-medium rounded bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors border border-green-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Approve Selected ({selectedPaths().size})
          </button>
        </Show>

        <button
          onClick={() => setSelectMode(selectMode() === "select" ? "none" : "select")}
          class={`px-2 py-1 text-[11px] font-medium rounded border transition-colors ${
            selectMode() === "select"
              ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
              : "bg-transparent text-text-muted border-border-weaker-base hover:border-border"
          }`}
        >
          <Icon name="checklist" class="w-3 h-3 inline-block mr-1" />
          {selectMode() === "select" ? "Done" : "Select"}
        </button>
      </div>

      {/* File list */}
      <div class="flex-1 overflow-y-auto overflow-x-hidden">
        <For each={touchFiles()}>
          {(file) => {
            const status = () => approvals()[file.path] ?? "pending"
            const op = OPERATION_LABELS[file.operation]

            return (
              <div
                class="flex items-start gap-2 px-3 py-2 hover:bg-background-menu transition-colors border-b border-border-weaker-base group"
                classList={{
                  "opacity-50": status() === "denied",
                  "bg-green-500/5": status() === "approved",
                  "bg-blue-500/5": status() === "readonly",
                }}
              >
                {/* Select checkbox */}
                <Show when={selectMode() === "select"}>
                  <button
                    onClick={() => toggleSelect(file.path)}
                    class="mt-0.5 shrink-0 w-4 h-4 rounded border border-border flex items-center justify-center hover:border-text-muted transition-colors"
                    classList={{
                      "bg-blue-500 border-blue-500": selectedPaths().has(file.path),
                    }}
                  >
                    <Show when={selectedPaths().has(file.path)}>
                      <Icon name="check-small" class="w-3 h-3 text-white" />
                    </Show>
                  </button>
                </Show>

                {/* Operation icon */}
                <span
                  class="mt-0.5 w-6 h-6 rounded flex items-center justify-center shrink-0 text-[11px] border"
                  classList={{
                    "bg-blue-500/10 text-blue-400 border-blue-500/20": file.operation === "read",
                    "bg-yellow-500/10 text-yellow-400 border-yellow-500/20": file.operation === "modify",
                    "bg-green-500/10 text-green-400 border-green-500/20": file.operation === "create",
                    "bg-red-500/10 text-red-400 border-red-500/20": file.operation === "delete",
                    "bg-purple-500/10 text-purple-400 border-purple-500/20": file.operation === "protect",
                  }}
                >
                  {op.label[0]}
                </span>

                {/* File info */}
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-medium text-text truncate">{file.path}</span>
                    <Tag size="normal" class={`text-[10px] ${RISK_COLORS[file.riskLevel]}`}>
                      {file.riskLevel}
                    </Tag>
                    <span class="text-[10px] text-text-muted ml-auto shrink-0">{op.label}</span>
                  </div>
                  <div class="text-[11px] text-text-muted mt-0.5 truncate">{file.reason}</div>

                  {/* Associated tests */}
                  <Show when={file.associatedTests.length > 0}>
                    <div class="flex items-center gap-1.5 mt-1">
                      <Icon name="console" class="w-3 h-3 text-text-muted" />
                      <span class="text-[10px] text-text-muted truncate">
                        {file.associatedTests.join(", ")}
                      </span>
                    </div>
                  </Show>
                </div>

                {/* Actions (visible when not in select mode) */}
                <Show when={selectMode() !== "select"}>
                  <div class="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => setFileStatus(file.path, "approved")}
                      class="w-6 h-6 rounded flex items-center justify-center text-green-400 hover:bg-green-500/10 transition-colors"
                      title="Approve"
                      classList={{ "opacity-40": status() === "approved" }}
                    >
                      <Icon name="check" class="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setFileStatus(file.path, "readonly")}
                      class="w-6 h-6 rounded flex items-center justify-center text-blue-400 hover:bg-blue-500/10 transition-colors"
                      title="Read-only investigation"
                      classList={{ "opacity-40": status() === "readonly" }}
                    >
                      <Icon name="eye" class="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setFileStatus(file.path, "denied")}
                      class="w-6 h-6 rounded flex items-center justify-center text-red-400 hover:bg-red-500/10 transition-colors"
                      title="Deny path"
                      classList={{ "opacity-40": status() === "denied" }}
                    >
                      <Icon name="close" class="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        // Add path claim action — would trigger reservation endpoint
                      }}
                      class="w-6 h-6 rounded flex items-center justify-center text-text-muted hover:text-text hover:bg-background-element transition-colors"
                      title="Add path claim"
                    >
                      <Icon name="code" class="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => {
                        // Require tests action — would mark for test requirement
                      }}
                      class="w-6 h-6 rounded flex items-center justify-center text-text-muted hover:text-text hover:bg-background-element transition-colors"
                      title="Require tests before checkpoint"
                    >
                      <Icon name="console" class="w-3 h-3" />
                    </button>
                  </div>
                </Show>

                {/* Status indicator */}
                <Show when={selectMode() !== "select"}>
                  <span class={`text-[10px] font-medium shrink-0 ${STATUS_COLORS[status()]}`}>
                    {status()}
                  </span>
                </Show>
              </div>
            )
          }}
        </For>
      </div>

      {/* Footer with summary actions */}
      <div class="flex items-center gap-2 px-3 py-2 border-t border-border bg-background-element">
        <Show
          when={approvalCount().pending === 0}
          fallback={
            <span class="text-[11px] text-text-muted">
              {approvalCount().pending} files pending review
            </span>
          }
        >
          <div class="flex items-center gap-1.5 text-[11px] text-green-400">
            <Icon name="circle-check" class="w-3.5 h-3.5" />
            All files reviewed
          </div>
        </Show>
      </div>
    </div>
  )
}
