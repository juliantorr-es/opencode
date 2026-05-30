import { For, Show } from "solid-js"
import type { RuntimeEvent } from "@/context/inspector"
import { EVENT_CATEGORY_LABELS, EVENT_STATUS_COLORS } from "@/context/inspector"
import type { FailureHotspot } from "@/context/event-queries"

// ── Types ──

export type ErrorAction =
  | "open-test"
  | "ask-agent-repair"
  | "run-failing-tests"
  | "show-last-edit"
  | "revert-hunk"
  | "mark-pre-existing"
  | "escalate"

export interface ErrorActionDef {
  id: ErrorAction
  label: string
  icon: string
  description: string
}

export const ERROR_ACTIONS: ErrorActionDef[] = [
  { id: "open-test", label: "Open failing test", icon: "🧪", description: "Navigate to the test file that exercises this code path" },
  { id: "ask-agent-repair", label: "Ask agent to repair", icon: "🤖", description: "Let an agent investigate and fix the failure" },
  { id: "run-failing-tests", label: "Run only failing tests", icon: "▶️", description: "Re-run only the tests that failed in this session" },
  { id: "show-last-edit", label: "Show last related edit", icon: "✏️", description: "Show the most recent edit to the failing file" },
  { id: "revert-hunk", label: "Revert suspected hunk", icon: "↩️", description: "Revert the specific hunk most likely causing the failure" },
  { id: "mark-pre-existing", label: "Mark as pre-existing", icon: "📌", description: "Tag this failure as pre-existing — not caused by current changes" },
  { id: "escalate", label: "Escalate to full investigation", icon: "🔍", description: "Open a full investigation session to root cause this" },
]

const ACTION_SET: Record<string, ErrorActionDef> = {}
for (const a of ERROR_ACTIONS) ACTION_SET[a.id] = a

export function getActionDef(id: string): ErrorActionDef | undefined {
  return ACTION_SET[id]
}

// ── Severity Colors ──

const SEVERITY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  fatal: { bg: "bg-red-500/15", text: "text-red-400", border: "border-red-500/30" },
  error: { bg: "bg-amber-500/15", text: "text-amber-400", border: "border-amber-500/30" },
  warning: { bg: "bg-yellow-500/10", text: "text-yellow-400", border: "border-yellow-500/20" },
}

// ── Error Card Props ──

export interface ErrorCardProps {
  event: RuntimeEvent
  hotspot: FailureHotspot
  onAction?: (action: ErrorAction, event: RuntimeEvent) => void
}

/**
 * ErrorCard — displays a single failed event with its normalized context
 * and available recovery actions.
 */
export function ErrorCard(props: ErrorCardProps) {
  const catInfo = () => EVENT_CATEGORY_LABELS[props.event.category] ?? EVENT_CATEGORY_LABELS.other
  const severityColor = () => SEVERITY_COLORS[props.hotspot.severity] ?? SEVERITY_COLORS.error

  return (
    <div
      class={`flex flex-col gap-2 p-2.5 rounded border ${severityColor().border} ${severityColor().bg}`}
    >
      {/* Header row — type + recoverable badge */}
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-1.5 min-w-0 flex-1">
          <span class="text-sm shrink-0">{catInfo().icon}</span>
          <div class="min-w-0">
            <div class="text-xs font-medium text-text truncate" title={props.event.type}>
              {shortLabel(props.event.type)}
            </div>
            <Show when={props.event.tool}>
              <div class="text-[10px] text-text-muted truncate">
                {props.event.tool}
                <Show when={props.event.file}>
                  <span class="ml-1">· {props.event.file}</span>
                </Show>
              </div>
            </Show>
          </div>
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          <span
            class={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${
              props.event.status === "failed" ? "bg-red-500/20 text-red-400" : "bg-amber-500/20 text-amber-400"
            }`}
          >
            <span class="w-1 h-1 rounded-full bg-current" />
            {props.event.status}
          </span>
          <RecoverableBadge recoverable={props.hotspot.recoverable} />
        </div>
      </div>

      {/* Error message */}
      <Show when={props.event.error}>
        <div class="text-[10px] font-mono text-red-400 bg-red-950/20 rounded px-1.5 py-1 leading-relaxed break-all">
          {props.event.error}
        </div>
      </Show>

      {/* Normalized code + count */}
      <div class="flex items-center gap-2 text-[10px] text-text-muted">
        <span class="font-mono">{props.hotspot.code}</span>
        <Show when={props.hotspot.count > 1}>
          <span class="text-text-muted/60">·</span>
          <span>{props.hotspot.count} similar failure{props.hotspot.count !== 1 ? "s" : ""}</span>
        </Show>
      </div>

      {/* Suggested actions */}
      <div class="flex flex-wrap gap-1 mt-0.5">
        <For each={props.hotspot.suggestedActions}>
          {(actionLabel) => {
            const def = ERROR_ACTIONS.find((a) => a.label === actionLabel)
            if (!def) return null
            return (
              <button
                class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-border bg-background-element hover:bg-background-menu text-text-muted hover:text-text transition-colors"
                title={def.description}
                onClick={() => props.onAction?.(def.id, props.event)}
              >
                <span>{def.icon}</span>
                <span>{def.label}</span>
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}

// ── Error Group Card (multi-event) ──

export interface ErrorGroupCardProps {
  hotspot: FailureHotspot
  onAction?: (action: ErrorAction, event: RuntimeEvent) => void
  expanded?: boolean
  onToggle?: () => void
}

/**
 * ErrorGroupCard — displays a grouped error code with count and expandable
 * list of individual error cards.
 */
export function ErrorGroupCard(props: ErrorGroupCardProps) {
  const severityColor = () => SEVERITY_COLORS[props.hotspot.severity] ?? SEVERITY_COLORS.error
  const isExpanded = () => props.expanded ?? false

  return (
    <div class={`flex flex-col rounded border ${severityColor().border}`}>
      {/* Group header */}
      <button
        class="flex items-center gap-2 p-2.5 text-left hover:bg-background-menu transition-colors"
        onClick={() => props.onToggle?.()}
      >
        <span class="text-xs shrink-0">{isExpanded() ? "▾" : "▸"}</span>
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <span
            class={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold ${severityColor().bg} ${severityColor().text}`}
          >
            {props.hotspot.count}
          </span>
          <div class="min-w-0">
            <div class="text-xs font-medium text-text">{props.hotspot.label}</div>
            <div class="text-[10px] text-text-muted font-mono">{props.hotspot.code}</div>
          </div>
        </div>
        <RecoverableBadge recoverable={props.hotspot.recoverable} />
      </button>

      {/* Expanded list */}
      <Show when={isExpanded()}>
        <div class="flex flex-col gap-1.5 p-2 pt-0 border-t border-border">
          <For each={props.hotspot.events}>
            {(event) => (
              <ErrorCard
                event={event}
                hotspot={props.hotspot}
                onAction={props.onAction}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

// ── Recoverable Badge ──

function RecoverableBadge(props: { recoverable: boolean }) {
  return (
    <span
      class={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium ${
        props.recoverable
          ? "bg-green-500/10 text-green-400 border border-green-500/20"
          : "bg-red-500/10 text-red-400 border border-red-500/20"
      }`}
    >
      <span class={`w-1 h-1 rounded-full ${props.recoverable ? "bg-green-400" : "bg-red-400"}`} />
      {props.recoverable ? "Recoverable" : "Blocking"}
    </span>
  )
}

// ── Helpers ──

function shortLabel(type: string): string {
  return type
    .replace(/^session\.next\./, "")
    .replace(/^session\./, "")
    .replace(/^coordination\./, "")
}
