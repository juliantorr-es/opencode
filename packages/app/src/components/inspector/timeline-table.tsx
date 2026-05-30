import { createMemo, createSignal, For, JSX, Show } from "solid-js"
import type { RuntimeEvent, EventCategory, EventStatus } from "@/context/inspector"
import { EVENT_CATEGORY_LABELS, EVENT_STATUS_COLORS, useInspector } from "@/context/inspector"
import { WhyButton } from "./why-button"

const ROW_HEIGHT = 36
const OVERSCAN = 20
const COL_WIDTHS = {
  time: 80,
  type: 180,
  actor: 60,
  tool: 120,
  file: 120,
  status: 80,
  duration: 60,
  error: 160,
  why: 48,
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

function formatDuration(start: number, end?: number): string {
  if (!end) return ""
  const ms = end - start
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function typeShortLabel(type: string): string {
  return type.replace(/^session\.next\./, "").replace(/^session\./, "").replace(/^coordination\./, "")
}

const statusBadgeClass = (status: EventStatus): string => {
  switch (status) {
    case "started":
      return "bg-blue-500/20 text-blue-400 border-blue-500/30"
    case "succeeded":
      return "bg-green-500/20 text-green-400 border-green-500/30"
    case "failed":
      return "bg-red-500/20 text-red-400 border-red-500/30"
    case "denied":
      return "bg-amber-500/20 text-amber-400 border-amber-500/30"
    case "progress":
      return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30"
    default:
      return "bg-gray-500/20 text-gray-400 border-gray-500/30"
  }
}

export function TimelineTable() {
  const { filteredEvents, selectedEvent, selectEvent, stats } = useInspector()

  const [scrollTop, setScrollTop] = createSignal(0)
  const [containerHeight, setContainerHeight] = createSignal(600)
  const [whyEventId, setWhyEventId] = createSignal<string | null>(null)

  const totalHeight = createMemo(() => filteredEvents().length * ROW_HEIGHT)

  const visibleRange = createMemo(() => {
    const top = scrollTop()
    const height = containerHeight()
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN)
    const end = Math.min(filteredEvents().length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN)
    return { start, end }
  })

  const visibleEvents = createMemo(() => {
    const { start, end } = visibleRange()
    return filteredEvents().slice(start, end)
  })

  const offsetY = createMemo(() => visibleRange().start * ROW_HEIGHT)

  // When viewing why for an event, also select that event
  const handleWhyClick = (event: RuntimeEvent) => {
    selectEvent(event.id)
    setWhyEventId(event.id)
  }

  return (
    <div class="flex flex-col h-full">
      {/* Header */}
      <div class="flex items-center h-8 px-2 text-[11px] font-medium text-text-muted border-b border-border shrink-0">
        <div class="flex items-center gap-4 w-full">
          <span class="text-[10px] text-text-muted/60">
            {filteredEvents().length} event{filteredEvents().length !== 1 ? "s" : ""}
            <Show when={stats().errors > 0}>
              <span class="ml-2 text-red-400">
                · {stats().errors} error{stats().errors !== 1 ? "s" : ""}
              </span>
            </Show>
          </span>
          <table class="w-full table-fixed">
            <colgroup>
              <col style={`width: ${COL_WIDTHS.time}px`} />
              <col style={`width: ${COL_WIDTHS.type}px`} />
              <col style={`width: ${COL_WIDTHS.actor}px`} />
              <col style={`width: ${COL_WIDTHS.tool}px`} />
              <col style={`width: ${COL_WIDTHS.file}px`} />
              <col style={`width: ${COL_WIDTHS.status}px`} />
              <col style={`width: ${COL_WIDTHS.duration}px`} />
              <col />
              <col style={`width: ${COL_WIDTHS.why}px`} />
            </colgroup>
          </table>
        </div>
      </div>

      {/* Virtual scroll container */}
      <div
        class="flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={(e) => {
          const el = e.currentTarget
          setScrollTop(el.scrollTop)
          setContainerHeight(el.clientHeight)
        }}
      >
        <div style={{ height: `${totalHeight()}px`, position: "relative" }}>
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${offsetY()}px)`,
            }}
          >
            <For each={visibleEvents()}>
              {(event) => (
                <EventRow
                  event={event}
                  isSelected={selectedEvent()?.id === event.id}
                  onClick={() => selectEvent(event.id)}
                  onWhyClick={handleWhyClick}
                />
              )}
            </For>
          </div>
        </div>

        <Show when={filteredEvents().length === 0}>
          <div class="flex flex-col items-center justify-center h-48 gap-2 p-4 text-center">
            <span class="text-2xl">🔍</span>
            <p class="text-xs text-text-muted">No events match the current filters</p>
            <p class="text-[10px] text-text-muted max-w-48">
              Try adjusting the filters above or waiting for events to arrive
            </p>
          </div>
        </Show>
      </div>
    </div>
  )
}

function EventRow(props: {
  event: RuntimeEvent
  isSelected: boolean
  onClick: () => void
  onWhyClick: (event: RuntimeEvent) => void
}) {
  const cat = EVENT_CATEGORY_LABELS[props.event.category] ?? EVENT_CATEGORY_LABELS.other

  const handleWhy = (e: MouseEvent) => {
    e.stopPropagation()
    props.onWhyClick(props.event)
  }

  return (
    <div
      class="flex items-center h-[36px] px-2 text-xs border-b border-border-weaker cursor-pointer transition-colors hover:bg-background-menu"
      style={{
        "background-color": props.isSelected ? "var(--bg-background-menu, rgba(255,255,255,0.05))" : "transparent",
      }}
      onClick={props.onClick}
    >
      {/* Timestamp */}
      <div class="text-text-muted text-[10px] w-[80px] shrink-0 font-mono">
        {formatTime(props.event.timestamp)}
      </div>

      {/* Event type with icon */}
      <div class="flex items-center gap-1 w-[180px] shrink-0 overflow-hidden">
        <span class="text-[10px] shrink-0">{cat.icon}</span>
        <span class="truncate" title={props.event.type}>
          {typeShortLabel(props.event.type)}
        </span>
      </div>

      {/* Actor */}
      <div class="w-[60px] shrink-0 truncate text-text-muted" title={props.event.actor}>
        {props.event.actor ?? "—"}
      </div>

      {/* Tool */}
      <div class="w-[120px] shrink-0 truncate text-text-muted" title={props.event.tool}>
        {props.event.tool ?? "—"}
      </div>

      {/* File */}
      <div class="w-[120px] shrink-0 truncate text-text-muted" title={props.event.file}>
        <Show when={props.event.file}>
          <span class="text-[10px]">📄</span> {props.event.file}
        </Show>
      </div>

      {/* Status badge */}
      <div class="w-[80px] shrink-0">
        <span
          class={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border ${statusBadgeClass(props.event.status)}`}
        >
          {props.event.status}
        </span>
      </div>

      {/* Duration */}
      <div class="w-[60px] shrink-0 text-[10px] text-text-muted font-mono">
        {props.event.duration ? formatDuration(0, props.event.duration) : "—"}
      </div>

      {/* Error */}
      <div class="flex-1 truncate text-red-400 text-[10px]">
        {props.event.error ?? ""}
      </div>

      {/* Why button */}
      <div class="w-[48px] shrink-0 flex items-center justify-end">
        <WhyButton event={props.event} onClick={props.onWhyClick} />
      </div>
    </div>
  )
}
