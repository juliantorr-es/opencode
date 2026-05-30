import { type JSX, createSignal } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import "./timeline-scrubber.css"

export interface TurnSummary {
  index: number
  userMessage: string
  agentType: "build" | "plan" | "ask" | "general"
  toolCallCount: number
  fileEditCount: number
  timestamp: number
  duration: number
}

export interface TimelineScrubberProps {
  turns: TurnSummary[]
  activeTurnIndex: number
  onTurnSelect: (index: number) => void
}

const agentColors: Record<TurnSummary["agentType"], string> = {
  build: "#3b82f6",
  plan: "#22c55e",
  ask: "#a855f7",
  general: "#6b7280",
}

export function TimelineScrubber(props: TimelineScrubberProps) {
  let trackRef: HTMLDivElement | undefined
  const [dragging, setDragging] = createSignal(false)

  if (props.turns.length === 0) return null

  /* Map a client X coordinate to the nearest turn index */
  function positionToIndex(clientX: number) {
    if (!trackRef) return 0
    const rect = trackRef.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return Math.round(ratio * (props.turns.length - 1))
  }

  /*
   * Pointer handlers for drag-to-scrub.
   * We set pointer capture so tracking works even when the pointer
   * leaves the element (e.g. fast horizontal drag).
   */
  function handlePointerDown(e: PointerEvent) {
    if (!trackRef) return
    trackRef.setPointerCapture(e.pointerId)
    setDragging(true)
    props.onTurnSelect(positionToIndex(e.clientX))
  }

  function handlePointerMove(e: PointerEvent) {
    if (!dragging()) return
    props.onTurnSelect(positionToIndex(e.clientX))
  }

  function handlePointerUp(e: PointerEvent) {
    if (!trackRef) return
    trackRef.releasePointerCapture(e.pointerId)
    setDragging(false)
  }

  /* Percentage position of the active turn center along the track */
  function handlePosition() {
    if (props.turns.length <= 1) return "50%"
    return `${(props.activeTurnIndex / (props.turns.length - 1)) * 100}%`
  }

  /* Tooltip content for a single turn */
  function turnTooltip(turn: TurnSummary): JSX.Element {
    const details: string[] = []
    if (turn.toolCallCount > 0) details.push(`${turn.toolCallCount} tool calls`)
    if (turn.fileEditCount > 0) details.push(`${turn.fileEditCount} files`)
    const suffix = details.length > 0 ? ` (${details.join(", ")})` : ""

    return (
      <span data-component="timeline-scrubber-tooltip">
        Turn {turn.index + 1}: {turn.userMessage}
        {suffix}
      </span>
    )
  }

  return (
    <div data-component="timeline-scrubber">
      <div
        ref={trackRef}
        data-component="timeline-scrubber-track"
        style={{ "touch-action": "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {props.turns.map((turn) => (
          <Tooltip
            value={turnTooltip(turn)}
            placement="top"
            class="flex-1 min-w-0"
          >
            <div
              data-component="timeline-scrubber-turn"
              data-active={turn.index === props.activeTurnIndex}
              onClick={() => props.onTurnSelect(turn.index)}
            >
              <div
                data-component="timeline-scrubber-dot"
                data-active={turn.index === props.activeTurnIndex}
              />
              <div
                data-component="timeline-scrubber-answer-bar"
                data-type={turn.agentType}
                style={{ background: agentColors[turn.agentType] }}
              />
            </div>
          </Tooltip>
        ))}

        {/* Downward-pointing triangle at the active turn */}
        <div
          data-component="timeline-scrubber-indicator"
          style={{ left: handlePosition() }}
          aria-hidden="true"
        />

        {/* Draggable scrub handle */}
        <div
          data-component="timeline-scrubber-handle"
          style={{ left: handlePosition() }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
