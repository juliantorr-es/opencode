import { Show, splitProps, type JSX } from "solid-js"
import { Icon } from "./icon"
import "./empty-state-v2.css"

export type EmptyStateV2Variant = "default" | "error" | "search-no-results"

export interface EmptyStateV2Props {
  class?: string
  classList?: Record<string, boolean | undefined>
  /** Icon name from v2 icon set */
  icon?: string
  /** Custom icon element (overrides icon name) */
  iconEl?: JSX.Element
  /** Title text */
  title: string
  /** Description text */
  description?: string
  /** Action button label */
  actionLabel?: string
  /** Action button click handler */
  onAction?: () => void
  /** Visual variant */
  variant?: EmptyStateV2Variant
}

export function EmptyStateV2(props: EmptyStateV2Props) {
  const [local, others] = splitProps(props, [
    "class",
    "classList",
    "icon",
    "iconEl",
    "title",
    "description",
    "actionLabel",
    "onAction",
    "variant",
  ])

  const variantIcon = () => {
    if (local.icon) return local.icon
    switch (local.variant) {
      case "error":
        return "status"
      case "search-no-results":
        return "magnifying-glass"
      default:
        return "grid-plus"
    }
  }

  return (
    <div
      data-component="empty-state-v2"
      data-variant={local.variant ?? "default"}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <div data-slot="empty-state-v2-icon">
        <Show when={local.iconEl} fallback={<Icon name={variantIcon()} size="large" />}>
          {local.iconEl}
        </Show>
      </div>
      <h3 data-slot="empty-state-v2-title">{local.title}</h3>
      <Show when={local.description}>
        <p data-slot="empty-state-v2-description">{local.description}</p>
      </Show>
      <Show when={local.actionLabel && local.onAction}>
        <button data-slot="empty-state-v2-action" onClick={local.onAction}>
          {local.actionLabel}
        </button>
      </Show>
    </div>
  )
}
