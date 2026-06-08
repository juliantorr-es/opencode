import { Popover } from "@tribunus/ui/popover"
import { Icon } from "@tribunus/ui/icon"
import { createSignal, Show } from "solid-js"
import { useAmbient, type WatcherStatus } from "@/context/ambient"

const STATUS_ICONS = {
  ok: "check",
  info: "bubble-5",
  warning: "warning",
  alert: "circle-ban-sign",
} as const

const STATUS_COLORS = {
  ok: "#22c55e",
  info: "#3b82f6",
  warning: "#f59e0b",
  alert: "#ef4444",
} as const

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function AmbientPopover(props: {
  insight: WatcherStatus
  onClose: () => void
}) {
  const ambient = useAmbient()
  const [open, setOpen] = createSignal(true)

  const handleClose = () => {
    setOpen(false)
    props.onClose()
  }

  const handleDismiss = () => {
    ambient.dismiss(props.insight.id)
    handleClose()
  }

  const statusIcon = () => {
    const icon = STATUS_ICONS[props.insight.status as keyof typeof STATUS_ICONS]
    return icon ?? "info"
  }
  const statusColor = () => {
    const color = STATUS_COLORS[props.insight.status as keyof typeof STATUS_COLORS]
    return color ?? STATUS_COLORS.info
  }

  return (
    <Popover
      open={open()}
      onOpenChange={(next) => {
        if (!next) handleClose()
        setOpen(next)
      }}
      placement="top-end"
      gutter={8}
      class="ambient-popover"
    >
      <div data-component="ambient-popover-card" class="ambient-popover-card">
        <div class="ambient-popover-header">
          <span class="ambient-popover-icon" style={{ color: statusColor() }}>
            <Icon name={statusIcon()} size="small" />
          </span>
          <span class="ambient-popover-title">{props.insight.label}</span>
        </div>

        <p class="ambient-popover-description">{props.insight.description}</p>

        <div class="ambient-popover-footer">
          <span class="ambient-popover-timestamp">{timeAgo(props.insight.timestamp)}</span>

          <div class="ambient-popover-actions">
            <Show when={props.insight.action}>
              <button
                data-component="ambient-action-btn"
                class="ambient-action-btn"
                onClick={() => {
                  props.insight.action!.run()
                  handleClose()
                }}
              >
                {props.insight.action!.label}
              </button>
            </Show>

            <Show when={props.insight.dismissible}>
              <button
                data-component="ambient-dismiss-btn"
                class="ambient-dismiss-btn"
                onClick={handleDismiss}
              >
                Dismiss
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Popover>
  )
}
