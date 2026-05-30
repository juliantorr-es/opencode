import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useSessionViz } from "@/context/session-viz"
import type { ActivityType } from "@/context/session-viz"

// Event type to display mapping
const EVENT_ICONS: Partial<Record<ActivityType, string>> = {
  tool_call: "🔧",
  file_edit: "📝",
  message: "💬",
  permission: "🔑",
  llm_turn: "🤖",
  session_status: "🔵",
  task_status: "⚡",
}

const EVENT_LABELS: Partial<Record<ActivityType, string>> = {
  tool_call: "Tool Call",
  file_edit: "File Edit",
  message: "Message",
  permission: "Permission",
  llm_turn: "LLM Turn",
  session_status: "Status",
  task_status: "Task",
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 1000) return "now"
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  return `${Math.floor(diff / 3600000)}h ago`
}

export function ActivityFeed() {
  const { activity, sessions, isConnected, agentHeartbeat } = useSessionViz()
  const [autoScroll, setAutoScroll] = createSignal(true)
  let containerRef: HTMLDivElement | undefined

  // Memoized current active agent heartbeat
  const currentAgentActivity = createMemo(() => {
    for (const s of sessions()) {
      if (s.agentHeartbeat && s.status === "active") {
        return s.agentHeartbeat
      }
    }
    return undefined
  })

  // Get session color by ID
  const sessionColor = (id: string): string => {
    const s = sessions().find((s) => s.id === id)
    return s?.color ?? "#888"
  }

  // Agent name to color mapping for badges
  const AGENT_COLORS: Record<string, string> = {
    build: "#4A90D9",
    plan: "#E67E22",
    ask: "#2ECC71",
    general: "#9B59B6",
  }
  const agentBadgeColor = (name: string): string => {
    return AGENT_COLORS[name.toLowerCase()] ?? "#888"
  }

  // Auto-scroll when new events arrive
  createEffect(() => {
    const items = activity()
    // Access items to create dependency
    if (items.length > 0 && autoScroll() && containerRef) {
      // Use requestAnimationFrame to wait for DOM update
      requestAnimationFrame(() => {
        if (containerRef) {
          containerRef.scrollTop = containerRef.scrollHeight
        }
      })
    }
  })

  return (
    <div class="flex flex-col h-full">
      {/* Agent heartbeat section */}
      <div class="flex items-center gap-2 px-2 py-1.5 border-b border-border-weaker-base">
        <Show when={currentAgentActivity()}>
          {(hb) => (
            <div class="flex items-center gap-1.5 animate-in fade-in">
              <div class="relative">
                <div class="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              </div>
              <span class="text-[11px] font-medium text-text">{hb().agent}</span>
              <Show when={hb().toolName}>
                <span class="text-[10px] text-text-muted truncate max-w-[100px]">
                  {hb().toolName}
                  <Show when={hb().toolStatus === "running"}>
                    <span class="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  </Show>
                </span>
              </Show>
            </div>
          )}
        </Show>
      </div>
      <style>{`
  @keyframes agent-fade-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .animate-agent-switch {
    animation: agent-fade-in 0.3s ease-out;
  }
`}</style>
      {/* Activity list */}
      <div
        ref={containerRef}
        class="flex-1 overflow-y-auto overflow-x-hidden scroll-smooth"
        onScroll={(e) => {
          const el = e.currentTarget
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
          setAutoScroll(nearBottom)
        }}
      >
        {activity().length === 0 ? (
          <div class="flex flex-col items-center justify-center h-full gap-1 p-4 text-center">
            {isConnected() ? (
              <>
                <div class="w-8 h-8 rounded-full bg-background-menu flex items-center justify-center">
                  <span class="text-base">⚡</span>
                </div>
                <p class="text-xs text-text-muted">Waiting for activity...</p>
                <p class="text-[10px] text-text-muted max-w-36">
                  Tool calls, file edits, and session events will appear here
                </p>
              </>
            ) : (
              <>
                <div class="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center">
                  <span class="text-base">🔌</span>
                </div>
                <p class="text-xs text-red-500 font-medium">Disconnected</p>
                <p class="text-[10px] text-text-muted max-w-36">
                  Waiting for event stream connection
                </p>
              </>
            )}
          </div>
        ) : (
          <div class="flex flex-col gap-px">
            <For each={activity()}>
              {(entry) => (
                <div class="flex items-start gap-2 px-2 py-1.5 hover:bg-background-menu transition-colors rounded cursor-default group">
                  {/* Session color dot */}
                  <span
                    class="w-2 h-2 rounded-full mt-1 shrink-0"
                    style={{ "background-color": sessionColor(entry.session_id) }}
                  />

                  {/* Event icon */}
                  <span class="text-xs shrink-0">
                    {EVENT_ICONS[entry.type] ?? "●"}
                  </span>

                  {/* Event content */}
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5">
                      <span
                        class="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ "background-color": agentBadgeColor(entry.agent) }}
                      />
                      <span
                        class="text-xs font-medium truncate"
                        style={{ color: agentBadgeColor(entry.agent) }}
                      >
                        {entry.agent}
                      </span>
                      <span class="text-[10px] text-text-muted shrink-0">
                        {EVENT_LABELS[entry.type] ?? entry.type}
                      </span>
                    </div>
                    <div class="text-xs truncate text-text">{entry.summary}</div>
                    <div class="text-[10px] text-text-muted">
                      {formatRelativeTime(entry.timestamp)}
                    </div>
                  </div>
                </div>
              )}
            </For>
          </div>
        )}
      </div>
    </div>
  )
}
