import { createMemo, createSignal, For, Show } from "solid-js"
import { useInspector } from "@/context/inspector"
import { queryFailureHotspots, type FailureHotspot } from "@/context/event-queries"
import { ErrorGroupCard, type ErrorAction } from "./error-card"

// ── Error Recovery Workflow ──

export interface ErrorRecoveryProps {
  /** Minimum failures before auto-prompting the recovery dialog (default 1) */
  minFailures?: number
  /** Callback when any action button is clicked */
  onAction?: (action: ErrorAction, hotspot: FailureHotspot) => void
  /** If true, always show the recovery panel even when there are no errors */
  alwaysShow?: boolean
}

/**
 * ErrorRecovery — listens for tool.failed events from InspectorContext,
 * groups failures by normalized error code, and displays a recoverable
 * error recovery workflow. Can be embedded in the inspector page or
 * used as a detached dialog trigger.
 */
export function ErrorRecovery(props: ErrorRecoveryProps) {
  const { events } = useInspector()
  const [expandedCode, setExpandedCode] = createSignal<string | null>(null)
  const [dismissedCodes, setDismissedCodes] = createSignal(new Set<string>())

  const minFailures = () => props.minFailures ?? 1

  const query = createMemo(() => queryFailureHotspots(events()))

  const visibleHotspots = createMemo(() =>
    query().hotspots.filter((h) => !dismissedCodes().has(h.code)),
  )

  const hasFailures = createMemo(() => visibleHotspots().length > 0)

  const totalActive = createMemo(() => {
    let count = 0
    for (const h of visibleHotspots()) count += h.count
    return count
  })

  const handleToggle = (code: string) => {
    setExpandedCode((prev) => (prev === code ? null : code))
  }

  const handleAction = (action: ErrorAction, hotspot: FailureHotspot) => {
    props.onAction?.(action, hotspot)
  }

  const handleDismissCode = (code: string) => {
    setDismissedCodes((prev) => new Set([...prev, code]))
  }

  const handleDismissAll = () => {
    const all = new Set(visibleHotspots().map((h) => h.code))
    setDismissedCodes(new Set(all))
  }

  const handleRestoreAll = () => {
    setDismissedCodes(new Set<string>())
  }

  return (
    <div class="flex flex-col gap-2">
      {/* Header bar */}
      <div class="flex items-center justify-between px-2 py-1">
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium text-text">Error Recovery</span>
          <Show when={query().totalFailures > 0}>
            <span class="text-[10px] text-text-muted">
              {query().totalFailures} failure{query().totalFailures !== 1 ? "s" : ""}
              · {query().uniqueCodes} code{query().uniqueCodes !== 1 ? "s" : ""}
            </span>
          </Show>
        </div>
        <div class="flex items-center gap-1">
          <Show when={dismissedCodes().size > 0}>
            <button
              class="text-[10px] text-text-muted hover:text-text transition-colors px-1.5 py-0.5"
              onClick={handleRestoreAll}
            >
              Restore dismissed
            </button>
          </Show>
          <Show when={visibleHotspots().length > 0}>
            <button
              class="text-[10px] text-text-muted hover:text-text transition-colors px-1.5 py-0.5"
              onClick={handleDismissAll}
            >
              Dismiss all
            </button>
          </Show>
        </div>
      </div>

      {/* Hotspot groups */}
      <Show
        when={visibleHotspots().length > 0}
        fallback={
          <Show when={props.alwaysShow}>
            <div class="flex flex-col items-center justify-center py-6 gap-1 text-center">
              <span class="text-lg">✅</span>
              <p class="text-xs text-text-muted">No failures to recover</p>
              <p class="text-[10px] text-text-muted">Failed events will appear here grouped by error code</p>
            </div>
          </Show>
        }
      >
        <div class="flex flex-col gap-1.5 px-2 pb-2 max-h-[500px] overflow-y-auto">
          <For each={visibleHotspots()}>
            {(hotspot) => (
              <div class="relative group">
                <ErrorGroupCard
                  hotspot={hotspot}
                  expanded={expandedCode() === hotspot.code}
                  onToggle={() => handleToggle(hotspot.code)}
                  onAction={(action, event) => handleAction(action, hotspot)}
                />
                <button
                  class="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-text-muted hover:text-text text-[10px] transition-opacity px-1"
                  onClick={() => handleDismissCode(hotspot.code)}
                  title="Dismiss this error group"
                >
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Dismissed bar */}
      <Show when={dismissedCodes().size > 0}>
        <div class="px-2 py-1 text-[10px] text-text-muted border-t border-border">
          {dismissedCodes().size} group{dismissedCodes().size !== 1 ? "s" : ""} dismissed
        </div>
      </Show>
    </div>
  )
}

// ── Inline Error Badge (for use in status bars / headers) ──

export interface ErrorBadgeProps {
  count: number
  onClick?: () => void
}

export function ErrorBadge(props: ErrorBadgeProps) {
  if (props.count === 0) return null
  return (
    <button
      class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors"
      onClick={props.onClick}
    >
      <span class="w-1.5 h-1.5 rounded-full bg-red-400" />
      <span>{props.count} error{props.count !== 1 ? "s" : ""}</span>
    </button>
  )
}
