import { Component, For, Show, type JSX } from "solid-js"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon, type IconProps } from "@tribunus/ui/icon"
import { TextField } from "@tribunus/ui/text-field"
import { useLocal } from "@/context/local"

export type ComposerPickerItemState = {
  icon: IconProps["name"]
  label: string
  selected?: boolean
  onSelect: () => void
}

export type ComposerPickerTriggerState = {
  action: string
  icon?: IconProps["name"]
  label: string
  class?: string
  style: JSX.CSSProperties | undefined
  onPress: () => void
}

export type ComposerPickerState = {
  open: boolean
  trigger: ComposerPickerTriggerState
  search: string
  searchPlaceholder: string
  clearLabel: string
  items: ComposerPickerItemState[]
  action: ComposerPickerItemState
  listClass?: string
  searchRef: (el: HTMLInputElement) => void
  onOpenChange: (open: boolean) => void
  onSearchInput: (value: string) => void
  onSearchClear: () => void
}

export type ComposerAgentControlState = {
  title: string
  keybind: string
  options: string[]
  current: string
  style: JSX.CSSProperties | undefined
  onSelect: (value: string | undefined) => void
}

export type ComposerModelControlState = {
  loading: boolean
  paid: boolean
  title: string
  keybind: string
  model: ReturnType<typeof useLocal>["model"]
  providerID?: string
  modelName: string
  style: JSX.CSSProperties | undefined
  onClose: () => void
  onUnpaidClick: () => void
}

export const ComposerPickerTrigger: Component<{ state: ComposerPickerTriggerState }> = (props) => {
  return (
    <button
      class={props.state.class}
      style={props.state.style}
      onClick={props.state.onPress}
    >
      <Show when={props.state.icon}>
        <Icon name={props.state.icon!} size="small" />
      </Show>
      <span>{props.state.label}</span>
    </button>
  )
}

export const ComposerPickerMenuItem: Component<{ state: ComposerPickerItemState }> = (props) => {
  return (
    <button
      class="w-full flex items-center gap-2 px-3 py-1.5 text-14-regular hover:bg-surface-raised-base-hover rounded-md"
      classList={{ "bg-surface-raised-base-hover": props.state.selected }}
      onClick={props.state.onSelect}
    >
      <Icon name={props.state.icon} size="small" class="shrink-0" />
      <span class="flex-1 text-left">{props.state.label}</span>
      <Show when={props.state.selected}>
        <Icon name="check" size="small" class="text-icon-info-active" />
      </Show>
    </button>
  )
}

export const ComposerPicker: Component<{ state: ComposerPickerState }> = (props) => {
  return (
    <KobaltePopover open={props.state.open} onOpenChange={props.state.onOpenChange}>
      <KobaltePopover.Trigger as={ComposerPickerTrigger} state={props.state.trigger} />
      <KobaltePopover.Content class="min-w-48 p-2 rounded-lg bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)]">
        <div class="flex items-center gap-2 px-1 pb-2">
          <TextField
            ref={props.state.searchRef}
            placeholder={props.state.searchPlaceholder}
            value={props.state.search}
            onInput={(e) => props.state.onSearchInput((e.target as HTMLInputElement).value)}
            class="flex-1"
          />
          <Show when={props.state.search}>
            <button onClick={props.state.onSearchClear} class="text-text-weak hover:text-text-strong">
              {props.state.clearLabel}
            </button>
          </Show>
        </div>
        <div class={props.state.listClass}>
          <For each={props.state.items}>
            {(item) => <ComposerPickerMenuItem state={item} />}
          </For>
        </div>
        <Show when={props.state.action}>
          <div class="border-t border-border-base mt-1 pt-1">
            <ComposerPickerMenuItem state={props.state.action} />
          </div>
        </Show>
      </KobaltePopover.Content>
    </KobaltePopover>
  )
}

export const ComposerAgentControl: Component<{ state: ComposerAgentControlState }> = (props) => {
  return (
    <div style={props.state.style} class="flex items-center gap-1.5">
      <Icon name="brain" size="small" class="text-icon-info-active" />
      <span class="text-14-regular text-text-strong">{props.state.title}</span>
      <Show when={props.state.current}>
        <span class="text-14-regular text-text-weak">{props.state.current}</span>
      </Show>
    </div>
  )
}

export const ComposerModelControl: Component<{ state: ComposerModelControlState }> = (props) => {
  return (
    <div style={props.state.style} class="flex items-center gap-1.5">
      <Show when={props.state.loading}>
        <span class="animate-spin inline-block size-3 border-2 border-current border-t-transparent rounded-full" />
      </Show>
      <Show when={!props.state.loading && props.state.paid}>
        <Icon name="check" size="small" class="text-icon-success" />
      </Show>
      <Show when={!props.state.loading && !props.state.paid}>
        <button onClick={props.state.onUnpaidClick} class="text-icon-warning hover:text-icon-warning-strong">
          {props.state.title}
        </button>
      </Show>
      <Show when={!props.state.loading}>
        <span class="text-14-regular text-text-strong">{props.state.modelName}</span>
      </Show>
    </div>
  )
}
