import { Show } from "solid-js"
import type { RuntimeEvent } from "@/context/inspector"

export interface WhyButtonProps {
  event: RuntimeEvent
  onClick: (event: RuntimeEvent) => void
  disabled?: boolean
}

/**
 * "Why?" button rendered next to each event in the timeline.
 * Clicking it opens the explanation panel for that event.
 */
export function WhyButton(props: WhyButtonProps) {
  return (
    <Show when={props.event.actor === "assistant" || props.event.actor === "tool" || !!props.event.tool || !!props.event.file}>
      <button
        class="inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px] font-medium
               rounded border border-transparent
               text-text-muted hover:text-accent hover:border-accent/30
               hover:bg-accent/5 active:bg-accent/10
               transition-all duration-150 cursor-pointer
               leading-none shrink-0"
        onClick={(e) => {
          e.stopPropagation()
          props.onClick(props.event)
        }}
        disabled={props.disabled}
        title="Explain why this event happened"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          class="w-3 h-3"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="8" cy="8" r="6" />
          <path d="M6 6.5a2 2 0 1 1 4 0c0 1-2 1.5-2 3" />
          <circle cx="8" cy="12.5" r="0.5" fill="currentColor" stroke="none" />
        </svg>
        Why?
      </button>
    </Show>
  )
}
