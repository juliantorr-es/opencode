import { useSessionViz } from "@/context/session-viz"
import { useSettings } from "@/context/settings"
import { ActivityFeed } from "./activity-feed"
import { CodebaseMap } from "./codebase-map"

export function VizPanel() {
  const { sessions, isConnected } = useSessionViz()
  const settings = useSettings()
  const showViz = () => settings.general.showSessionViz() ?? false

  if (!showViz()) {
    return (
      <div class="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
        <span class="text-lg">📊</span>
        <p class="text-xs text-text-muted">Session visualization is disabled</p>
        <p class="text-[10px] text-text-muted">Enable it in Settings → General</p>
      </div>
    )
  }

  if (!isConnected()) {
    return (
      <div class="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
        <div class="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center">
          <span class="text-lg">🔌</span>
        </div>
        <p class="text-xs text-text-muted font-medium">Connection Lost</p>
        <p class="text-[10px] text-text-muted max-w-40">
          The event stream is disconnected. Session activity will appear when reconnected.
        </p>
        <div class="flex items-center gap-1.5 mt-1">
          <span class="w-1.5 h-1.5 rounded-full bg-red-500" />
          <span class="text-[10px] text-red-500">Reconnecting...</span>
        </div>
      </div>
    )
  }

  if (sessions().length === 0) {
    return (
      <div class="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
        <span class="text-lg">👀</span>
        <p class="text-xs text-text-muted font-medium">No Active Sessions</p>
        <p class="text-[10px] text-text-muted max-w-40">
          Active coding sessions and their activity will appear here in real-time.
        </p>
      </div>
    )
  }

  const AGENT_COLORS: Record<string, string> = {
    build: "#4A90D9",
    plan: "#E67E22",
    ask: "#2ECC71",
    general: "#9B59B6",
  }
  const agentBadgeColor = (name: string): string => AGENT_COLORS[name.toLowerCase()] ?? "#888"

  return (
    <div class="flex flex-col h-full gap-2 p-2">
      {/* Connection indicator */}
      <div class="flex items-center gap-2 text-xs text-text-muted">
        <span class="w-2 h-2 rounded-full bg-green-500" />
        {sessions().length} active session{sessions().length !== 1 ? "s" : ""}
      </div>

      {/* Mini turn indicator */}
      <div class="flex items-center gap-1 py-1.5">
        {sessions().slice(0, 1).map((s) =>
          s.recent_activity.slice(0, 8).map((act, i) => (
            <div
              class="w-2 h-2 rounded-sm transition-all duration-200 hover:scale-150 cursor-pointer"
              style={{
                "background-color": act.agent === "user" ? "#666" : agentBadgeColor(act.agent),
                opacity: i === 0 ? 1 : 0.4 + (i / s.recent_activity.length) * 0.6,
              }}
              title={`${act.agent}: ${act.summary}`}
            />
          ))
        )}
      </div>

      {/* Codebase Map section */}
      <div class="flex-1 min-h-0">
        <div class="text-xs font-medium text-text-muted mb-1 uppercase tracking-wider">
          Codebase Activity
        </div>
        <div class="h-full rounded-lg border border-border bg-background-element overflow-hidden">
          <CodebaseMap />
        </div>
      </div>

      {/* Activity Feed section */}
      <div class="h-48 min-h-0">
        <div class="text-xs font-medium text-text-muted mb-1 uppercase tracking-wider">
          Recent Activity
        </div>
        <div class="h-full rounded-lg border border-border bg-background-element overflow-hidden">
          <ActivityFeed />
        </div>
      </div>
    </div>
  )
}
