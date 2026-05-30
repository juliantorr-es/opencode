import type { SafeModeAction } from "../../preload/types"
import type { Component } from "solid-js"

interface SafeModeCardProps {
  title: string
  description: string
  action: SafeModeAction
}

export const SafeModeCard: Component<SafeModeCardProps> = (props) => {
  const handleClick = () => {
    window.api.safeModeAction(props.action).catch(() => {
      // Safe mode actions are best-effort
    })
  }

  return (
    <button
      class="flex flex-col items-start gap-2 rounded-lg border border-surface-weak bg-surface-base p-4 text-left hover:bg-surface-weak transition-colors cursor-pointer w-full"
      onClick={handleClick}
      aria-label={props.title}
    >
      <span class="text-14-semibold text-text-strong">{props.title}</span>
      <span class="text-12-regular text-text-weak">{props.description}</span>
    </button>
  )
}
