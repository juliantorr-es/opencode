import { For } from "solid-js"
import { useSessionViz } from "@/context/session-viz"
import { useSettings } from "@/context/settings"

const STATUS_ICONS: Record<string, string> = {
  active: "▶",
  idle: "⏸",
  blocked: "⛔",
}

export function SessionBadges() {
  const { sessions } = useSessionViz()
  const settings = useSettings()
  const showViz = () => settings.general.showSessionViz() ?? false

  if (sessions().length === 0 || !showViz()) return null

  return (
    <div class="flex items-center gap-1.5 px-2">
      <For each={sessions().slice(0, 5)}>
        {(session) => (
          <div
            class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium cursor-default group relative"
            style={{ "background-color": `${session.color}15` }}
            title={`${session.agent}: ${session.mission_summary ?? session.status}`}
          >
            <span
              class="w-1.5 h-1.5 rounded-full"
              style={{ "background-color": session.color }}
            />
            <span style={{ color: session.color }} class="max-w-16 truncate">
              {session.agent}
            </span>
            <span class="text-text-muted">{STATUS_ICONS[session.status] ?? "●"}</span>
          </div>
        )}
      </For>
      {sessions().length > 5 && (
        <span class="text-[10px] text-text-muted">+{sessions().length - 5}</span>
      )}
    </div>
  )
}
