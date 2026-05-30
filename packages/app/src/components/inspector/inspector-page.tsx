import { createSignal, Show } from "solid-js"
import { InspectorProvider, useInspector } from "@/context/inspector"
import { AppErrorBoundary } from "@/components/error-boundary"
import { TimelineFilters } from "./timeline-filters"
import { TimelineTable } from "./timeline-table"
import { EventDetailDrawer } from "./event-detail-drawer"
import { SessionList } from "./session-list"
import { WhyPanel } from "./why-panel"

export function InspectorPage() {
  return (
    <AppErrorBoundary>
      <InspectorProvider>
        <InspectorShell />
      </InspectorProvider>
    </AppErrorBoundary>
  )
}

function InspectorShell() {
  const { selectedEvent, selectEvent, stats, connected } = useInspector()
  const [showSidebar, setShowSidebar] = createSignal(true)
  const [whyEventId, setWhyEventId] = createSignal<string | null>(null)

  const handleWhyClick = (eventId: string) => {
    setWhyEventId(eventId)
  }

  const handleCloseWhy = () => {
    setWhyEventId(null)
  }

  const handleNavigateFromWhy = (targetId: string) => {
    setWhyEventId(targetId)
  }

  // Show WhyPanel when active, otherwise show detail drawer
  const showWhy = () => whyEventId() !== null

  return (
    <div class="flex flex-col h-full bg-background-base">
      {/* Connection status bar */}
      <ConnectedBar connected={connected()} />

      {/* Main content area */}
      <div class="flex flex-1 min-h-0">
        {/* Left sidebar — Session List */}
        <Show when={showSidebar()}>
          <div class="w-56 shrink-0 border-r border-border bg-background-element">
            <SessionList />
          </div>
        </Show>

        {/* Main panel — Timeline */}
        <div class="flex-1 flex flex-col min-w-0">
          {/* Filter bar */}
          <TimelineFilters />

          {/* Timeline table */}
          <div class="flex-1 min-h-0">
            <TimelineTable />
          </div>
        </div>

        {/* Right panel — Event Detail or Why Panel */}
        <Show when={showWhy()} fallback={
          <Show when={selectedEvent()}>
            <div class="w-80 shrink-0">
              <EventDetailDrawer />
            </div>
          </Show>
        }>
          <div class="w-80 shrink-0 border-l border-border">
            <WhyPanel
              eventId={whyEventId()!}
              onClose={handleCloseWhy}
              onNavigate={handleNavigateFromWhy}
            />
          </div>
        </Show>
      </div>

      {/* Footer stats bar */}
      <div class="flex items-center justify-between px-2 py-1 border-t border-border text-[10px] text-text-muted">
        <div class="flex items-center gap-3">
          <span>{stats().total} events tracked</span>
          <span class="text-red-400">{stats().errors} errors</span>
          <span>{Object.keys(stats().byCategory).length} categories</span>
        </div>
        <div class="flex items-center gap-2">
          <Show when={showWhy()}>
            <button
              class="text-accent hover:text-text transition-colors cursor-pointer"
              onClick={handleCloseWhy}
            >
              Back to Details
            </button>
          </Show>
          <button
            class="text-text-muted hover:text-text transition-colors cursor-pointer"
            onClick={() => setShowSidebar(!showSidebar())}
          >
            {showSidebar() ? "Hide Sessions" : "Show Sessions"}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConnectedBar(props: { connected: boolean }) {
  return (
    <div
      class={`flex items-center gap-1.5 px-2 py-0.5 text-[10px] ${
        props.connected
          ? "bg-green-500/5 text-green-400"
          : "bg-red-500/5 text-red-400"
      }`}
    >
      <span
        class={`w-1.5 h-1.5 rounded-full ${
          props.connected ? "bg-green-500" : "bg-red-500 animate-pulse"
        }`}
      />
      {props.connected ? "Connected — receiving events" : "Disconnected — reconnecting..."}
    </div>
  )
}
