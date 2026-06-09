import { Show } from "solid-js"
import { useDesktopRuntime } from "../desktop-runtime-context"

/** Map sidecar status to color */
function statusColor(status: string): string {
  switch (status) {
    case "ready": return "bg-green-400"
    case "starting": return "bg-yellow-400"
    case "degraded": return "bg-orange-400"
    case "unavailable":
    case "error": return "bg-red-400"
    default: return "bg-gray-400"
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "ready": return "Ready"
    case "starting": return "Starting"
    case "degraded": return "Degraded"
    case "unavailable": return "Unavailable"
    case "error": return "Error"
    default: return status
  }
}

export function DesktopHealthIndicator(props: { onClick?: () => void }) {
  const { state } = useDesktopRuntime()

  return (
    <button
      class="flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-weak transition-colors"
      onClick={props.onClick}
      aria-label={`Desktop status: ${statusLabel(state.sidecar.status)}`}
    >
      <span class={`w-2 h-2 rounded-full ${statusColor(state.sidecar.status)}`} />
      <span class="text-11-medium text-text-weak">{statusLabel(state.sidecar.status)}</span>
    </button>
  )
}
