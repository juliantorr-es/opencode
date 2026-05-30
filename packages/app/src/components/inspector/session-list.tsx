import { createMemo, createSignal, For, Show } from "solid-js"
import { useInspector } from "@/context/inspector"

export function SessionList() {
  const { sessions, events, filters, setFilter } = useInspector()

  const sessionMeta = createMemo(() => {
    const counts: Record<string, { total: number; errors: number; lastEvent: number }> = {}
    for (const e of events()) {
      const m = counts[e.sessionID] ?? { total: 0, errors: 0, lastEvent: 0 }
      m.total++
      if (e.status === "failed" || e.error) m.errors++
      if (e.timestamp > m.lastEvent) m.lastEvent = e.timestamp
      counts[e.sessionID] = m
    }
    return counts
  })

  const sortedSessions = createMemo(() => {
    return [...sessions()].sort((a, b) => {
      const ma = sessionMeta()[a]
      const mb = sessionMeta()[b]
      return (mb?.lastEvent ?? 0) - (ma?.lastEvent ?? 0)
    })
  })

  const activeSession = () => filters().sessionID

  return (
    <div class="flex flex-col h-full">
      <div class="px-2 py-1.5 border-b border-border">
        <span class="text-[11px] font-medium text-text">Sessions</span>
        <span class="text-[10px] text-text-muted ml-1">({sessions().length})</span>
      </div>
      <div class="flex-1 overflow-y-auto">
        <For
          each={sortedSessions()}
          fallback={
            <div class="flex flex-col items-center justify-center h-24 gap-1 p-2 text-center">
              <p class="text-[10px] text-text-muted">No sessions yet</p>
              <p class="text-[9px] text-text-muted max-w-28">
                Events will appear here as they stream in
              </p>
            </div>
          }
        >
          {(sid) => {
            const meta = sessionMeta()[sid]
            const isActive = activeSession() === sid
            const truncated = sid.length > 24 ? sid.slice(0, 24) + "…" : sid

            return (
              <button
                class={`w-full flex items-start gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-background-menu ${
                  isActive ? "bg-background-menu border-l-2 border-text" : "border-l-2 border-transparent"
                }`}
                onClick={() => setFilter("sessionID", isActive ? "" : sid)}
              >
                <span class="text-xs mt-0.5">💬</span>
                <div class="flex-1 min-w-0">
                  <div class="text-[11px] truncate text-text" title={sid}>
                    {truncated}
                  </div>
                  <div class="flex items-center gap-2 text-[9px] text-text-muted">
                    <span>{meta?.total ?? 0} events</span>
                    <Show when={meta && meta.errors > 0}>
                      <span class="text-red-400">{meta!.errors} err</span>
                    </Show>
                  </div>
                </div>
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}
