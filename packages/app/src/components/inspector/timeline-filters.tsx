import { For, Show } from "solid-js"
import type { EventCategory, EventStatus } from "@/context/inspector"
import { EVENT_CATEGORIES, EVENT_CATEGORY_LABELS, useInspector } from "@/context/inspector"

const STATUS_FILTERS: Array<{ value: EventStatus; label: string }> = [
  { value: "started", label: "Started" },
  { value: "succeeded", label: "Success" },
  { value: "failed", label: "Failed" },
  { value: "denied", label: "Denied" },
  { value: "progress", label: "Progress" },
  { value: "info", label: "Info" },
]

const TIME_RANGES: Array<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
]

export function TimelineFilters() {
  const { filters, setFilter, clearFilters, stats } = useInspector()

  const toggleCategory = (cat: EventCategory) => {
    const current = filters().categories
    const next = current.includes(cat) ? current.filter((c) => c !== cat) : [...current, cat]
    setFilter("categories", next)
  }

  const toggleStatus = (status: EventStatus) => {
    const current = filters().statuses
    const next = current.includes(status) ? current.filter((s) => s !== status) : [...current, status]
    setFilter("statuses", next)
  }

  const hasActiveFilters = () => {
    const f = filters()
    return (
      f.categories.length > 0 ||
      f.statuses.length > 0 ||
      f.toolQuery !== "" ||
      f.fileQuery !== "" ||
      f.sessionID !== "" ||
      f.actor !== "" ||
      f.timeRange !== "all" ||
      f.showErrorsOnly ||
      f.showToolCallsOnly ||
      f.showFileEditsOnly
    )
  }

  return (
    <div class="flex flex-col gap-1.5 p-2 border-b border-border text-xs">
      {/* Quick filters row */}
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[10px] font-medium text-text-muted uppercase tracking-wider">Quick:</span>
        <button
          class={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
            filters().showErrorsOnly
              ? "bg-red-500/20 text-red-400 border-red-500/30"
              : "bg-transparent text-text-muted border-border hover:bg-background-menu"
          }`}
          onClick={() => setFilter("showErrorsOnly", !filters().showErrorsOnly)}
        >
          ⚠ Errors only
        </button>
        <button
          class={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
            filters().showToolCallsOnly
              ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
              : "bg-transparent text-text-muted border-border hover:bg-background-menu"
          }`}
          onClick={() => setFilter("showToolCallsOnly", !filters().showToolCallsOnly)}
        >
          🛠 Tool calls
        </button>
        <button
          class={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
            filters().showFileEditsOnly
              ? "bg-green-500/20 text-green-400 border-green-500/30"
              : "bg-transparent text-text-muted border-border hover:bg-background-menu"
          }`}
          onClick={() => setFilter("showFileEditsOnly", !filters().showFileEditsOnly)}
        >
          📁 File edits
        </button>

        <div class="flex-1" />

        <Show when={hasActiveFilters()}>
          <button
            class="px-2 py-0.5 text-[10px] rounded text-text-muted hover:text-text transition-colors"
            onClick={clearFilters}
          >
            ✕ Clear filters
          </button>
        </Show>
      </div>

      {/* Category filters */}
      <div class="flex items-center gap-1 flex-wrap">
        <span class="text-[10px] font-medium text-text-muted uppercase tracking-wider mr-1">Type:</span>
        <For each={EVENT_CATEGORIES}>
          {(cat) => {
            const info = EVENT_CATEGORY_LABELS[cat]
            const active = filters().categories.includes(cat)
            return (
              <button
                class={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                  active
                    ? "bg-background-menu text-text border border-border"
                    : "text-text-muted hover:text-text hover:bg-background-menu"
                }`}
                onClick={() => toggleCategory(cat)}
                title={info.label}
              >
                {info.icon} {cat}
              </button>
            )
          }}
        </For>
      </div>

      {/* Search row */}
      <div class="flex items-center gap-2 flex-wrap">
        {/* Status filters */}
        <div class="flex items-center gap-1">
          <span class="text-[10px] font-medium text-text-muted uppercase tracking-wider">Status:</span>
          <For each={STATUS_FILTERS}>
            {(s) => {
              const active = filters().statuses.includes(s.value)
              return (
                <button
                  class={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                    active
                      ? "bg-background-menu border-border"
                      : "border-transparent text-text-muted hover:bg-background-menu"
                  }`}
                  onClick={() => toggleStatus(s.value)}
                >
                  {s.label}
                </button>
              )
            }}
          </For>
        </div>

        {/* Time range */}
        <div class="flex items-center gap-1">
          <span class="text-[10px] font-medium text-text-muted uppercase tracking-wider">Time:</span>
          <For each={TIME_RANGES}>
            {(r) => (
              <button
                class={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                  filters().timeRange === r.value
                    ? "bg-background-menu text-text"
                    : "text-text-muted hover:text-text hover:bg-background-menu"
                }`}
                onClick={() => setFilter("timeRange", r.value)}
              >
                {r.label}
              </button>
            )}
          </For>
        </div>

        {/* Tool search */}
        <input
          type="text"
          placeholder="Search tool..."
          value={filters().toolQuery}
          onInput={(e) => setFilter("toolQuery", e.currentTarget.value)}
          class="w-28 px-1.5 py-0.5 text-[10px] bg-transparent border border-border rounded text-text placeholder-text-muted/40 outline-none focus:border-border focus:bg-background-menu"
        />

        {/* File search */}
        <input
          type="text"
          placeholder="Search file..."
          value={filters().fileQuery}
          onInput={(e) => setFilter("fileQuery", e.currentTarget.value)}
          class="w-28 px-1.5 py-0.5 text-[10px] bg-transparent border border-border rounded text-text placeholder-text-muted/40 outline-none focus:border-border focus:bg-background-menu"
        />

        {/* Actor search */}
        <input
          type="text"
          placeholder="Actor..."
          value={filters().actor}
          onInput={(e) => setFilter("actor", e.currentTarget.value)}
          class="w-20 px-1.5 py-0.5 text-[10px] bg-transparent border border-border rounded text-text placeholder-text-muted/40 outline-none focus:border-border focus:bg-background-menu"
        />
      </div>
    </div>
  )
}
