import { createSignal, onCleanup, For } from "solid-js"
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

const AGENT_COLORS: Record<TurnSummary["agentType"], string> = {
  build: "var(--accent-build, #58a6ff)",
  plan: "var(--accent-plan, #3fb950)",
  ask: "var(--accent-ask, #bc8cff)",
  general: "var(--accent-general, #8b949e)",
}

const AGENT_BAR_CLASS: Record<TurnSummary["agentType"], string> = {
  build: "agent-bar-build",
  plan: "agent-bar-plan",
  ask: "agent-bar-ask",
  general: "agent-bar-general",
}

const AGENT_TOOLTIP_CLASS: Record<TurnSummary["agentType"], string> = {
  build: "tooltip-agent-build",
  plan: "tooltip-agent-plan",
  ask: "tooltip-agent-ask",
  general: "tooltip-agent-general",
}

export function TimelineScrubber(props: TimelineScrubberProps) {
  let trackRef: HTMLDivElement | undefined
  const [dragIndex, setDragIndex] = createSignal<number | null>(null)
  const [hoverIndex, setHoverIndex] = createSignal<number | null>(null)

  const handlePointerDown = (index: number, e: PointerEvent) => {
    if (!trackRef) return
    e.preventDefault()
    setDragIndex(index)
    trackRef.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: PointerEvent) => {
    if (dragIndex() === null || !trackRef) return
    const rect = trackRef.getBoundingClientRect()
    const x = e.clientX - rect.left
    const pct = Math.max(0, Math.min(1, x / rect.width))
    const idx = Math.min(props.turns.length - 1, Math.max(0, Math.round(pct * (props.turns.length - 1))))
    if (idx !== props.activeTurnIndex) {
      props.onTurnSelect(idx)
    }
  }

  const handlePointerUp = () => {
    setDragIndex(null)
  }

  const handleSegmentClick = (index: number) => {
    if (index !== props.activeTurnIndex) {
      props.onTurnSelect(index)
    }
  }

  onCleanup(() => {
    setDragIndex(null)
  })

  const activeColor = () => {
    if (props.turns.length === 0) return AGENT_COLORS.build
    return AGENT_COLORS[props.turns[props.activeTurnIndex]?.agentType ?? "build"]
  }

  const activePct = () => {
    if (props.turns.length <= 1) return 50
    return ((props.activeTurnIndex / (props.turns.length - 1)) * 100)
  }

  return (
    <div
      class="scrubber"
      role="slider"
      aria-label="Conversation timeline"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, props.turns.length - 1)}
      aria-valuenow={props.activeTurnIndex}
    >
      <div
        class="scrubber-track"
        ref={trackRef}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <For each={props.turns}>
          {(turn) => (
            <div
              class="scrubber-segment"
              onClick={[handleSegmentClick, turn.index]}
              onPointerDown={[handlePointerDown, turn.index]}
              onMouseEnter={[setHoverIndex, turn.index]}
              onMouseLeave={[setHoverIndex, null]}
              role="button"
              tabIndex={0}
              aria-label={`Turn ${turn.index + 1}: ${turn.agentType} agent`}
            >
              <div class="scrubber-user-dot" />
              <div class={`scrubber-agent-bar ${AGENT_BAR_CLASS[turn.agentType]}`} />
              {hoverIndex() === turn.index && (
                <div class="scrubber-tooltip">
                  <div class="scrubber-tooltip-title">
                    {turn.userMessage.length > 40 ? turn.userMessage.slice(0, 40) + "…" : turn.userMessage}
                  </div>
                  <div class="scrubber-tooltip-detail">
                    <span class={`scrubber-tooltip-agent ${AGENT_TOOLTIP_CLASS[turn.agentType]}`}>
                      {turn.agentType}
                    </span>
                    {" — "}
                    {turn.toolCallCount} tool{turn.toolCallCount === 1 ? "" : "s"}
                    {turn.fileEditCount > 0 ? `, ${turn.fileEditCount} file${turn.fileEditCount === 1 ? "" : "s"}` : ""}
                    {turn.duration > 0 ? ` · ${(turn.duration / 1000).toFixed(1)}s` : ""}
                  </div>
                </div>
              )}
            </div>
          )}
        </For>
        {props.turns.length > 0 && (
          <>
            <div class="scrubber-active-indicator" style={{ "border-top-color": activeColor() }} />
            <div
              class={`scrubber-handle ${dragIndex() !== null ? "scrubber-handle-dragging" : ""}`}
              style={{ left: `${activePct()}%`, background: activeColor() }}
            />
          </>
        )}
      </div>
    </div>
  )
}

export default TimelineScrubber
