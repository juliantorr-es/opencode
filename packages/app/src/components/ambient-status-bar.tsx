import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useAmbient, type WatcherStatus } from "@/context/ambient"
import { AmbientPopover } from "./ambient-popover"
import "./ambient.css"

const MAX_VISIBLE = 4
const AUTO_HIDE_MS = 30_000
const STATUS_COLORS: Record<string, string> = {
  ok: "#22c55e",
  info: "#3b82f6",
  warning: "#f59e0b",
  alert: "#ef4444",
}

const severityOrder = ["alert", "warning", "info", "ok"] as const

export function AmbientStatusBar() {
  const ambient = useAmbient()
  const [visible, setVisible] = createSignal(false)
  const [selectedInsight, setSelectedInsight] = createSignal<WatcherStatus | undefined>()
  const [barVisible, setBarVisible] = createSignal(false)
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const sorted = createMemo(() => {
    const s = ambient.statuses
    if (!s?.length) return []
    return [...s].sort((a, b) => {
      const sa = severityOrder.indexOf(a.status as "ok" | "info" | "warning" | "alert")
      const sb = severityOrder.indexOf(b.status as "ok" | "info" | "warning" | "alert")
      return sa - sb || b.severity - a.severity
    })
  })

  const visibleInsights = createMemo(() => sorted().slice(0, MAX_VISIBLE))
  const overflowCount = createMemo(() => Math.max(0, sorted().length - MAX_VISIBLE))

  createEffect(() => {
    const count = ambient.statuses?.length ?? 0
    if (count > 0) {
      setBarVisible(true)
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        setBarVisible(false)
      }, AUTO_HIDE_MS)
    }
  })

  onCleanup(() => {
    clearTimeout(hideTimer)
  })

  return (
    <>
      <div
        data-component="ambient-bar"
        classList={{
          "ambient-bar-visible": barVisible() && sorted().length > 0,
          "ambient-bar-hidden": !barVisible() || sorted().length === 0,
        }}
        onClick={() => setVisible(true)}
      >
        <div class="ambient-bar-inner">
          <For each={visibleInsights()}>
            {(insight) => <AmbientDot insight={insight} />}
          </For>
          <Show when={overflowCount() > 0}>
            <span class="ambient-overflow">+{overflowCount()}</span>
          </Show>
        </div>
      </div>

      <Show when={visible() && selectedInsight()}>
        <AmbientPopover
          insight={selectedInsight()!}
          onClose={() => {
            setVisible(false)
            setSelectedInsight(undefined)
          }}
        />
      </Show>
    </>
  )
}

function AmbientDot(props: { insight: WatcherStatus }) {
  const ambient = useAmbient()
  const color = () => STATUS_COLORS[props.insight.status] ?? STATUS_COLORS.info

  return (
    <button
      data-component="ambient-dot"
      class="ambient-dot"
      onClick={() => ambient.setShowBar(true)}
      aria-label={props.insight.label}
    >
      <span class="ambient-dot-indicator" style={{ "background-color": color() }} />
      <span class="ambient-dot-label">{props.insight.label}</span>
    </button>
  )
}
