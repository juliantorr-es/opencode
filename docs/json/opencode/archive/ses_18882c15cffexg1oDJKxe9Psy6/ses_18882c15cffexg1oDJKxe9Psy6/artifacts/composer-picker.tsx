import type { ComponentProps, JSX } from "solid-js"
import { Show, For, splitProps } from "solid-js"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
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

export function ComposerPickerTrigger(props: ComponentProps<"button"> & { state: ComposerPickerTriggerState }) {
  const [local, rest] = splitProps(props, ["state", "class", "style", "onClick"])
  return (
    <button
      {...rest}
      data-action={local.state.action}
      type="button"
      class={`flex h-7 min-w-0 items-center gap-1.5 rounded px-2 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none ${local.state.class ?? ""}`}
      style={local.state.style}
      onClick={() => local.state.onPress()}
    >
      <Show when={local.state.icon}>
        {(icon) => <Icon name={icon()} size="small" class="shrink-0 text-v2-icon-icon-muted" />}
      </Show>
      <span class="min-w-0 truncate leading-5">{local.state.label}</span>
      <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
    </button>
  )
}

export function ComposerPickerMenuItem(props: { state: ComposerPickerItemState }) {
  return (
    <button
      type="button"
      class="flex h-7 w-full items-center gap-2 rounded px-3 text-left text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
      onClick={props.state.onSelect}
    >
      <Icon name={props.state.icon} size="small" class="shrink-0 text-v2-icon-icon-base" />
      <span class="min-w-0 flex-1 truncate leading-5">{props.state.label}</span>
      <Show when={props.state.selected}>
        <Icon name="check-small" size="small" class="shrink-0 text-v2-icon-icon-base" />
      </Show>
    </button>
  )
}

export function ComposerPicker(props: { state: ComposerPickerState }) {
  return (
    <KobaltePopover
      open={props.state.open}
      placement="bottom-start"
      gutter={4}
      modal={false}
      onOpenChange={props.state.onOpenChange}
    >
      <KobaltePopover.Trigger as={ComposerPickerTrigger} state={props.state.trigger} />
      <KobaltePopover.Portal>
        <KobaltePopover.Content
          class="w-[243px] overflow-hidden rounded-md bg-v2-background-bg-layer-01 shadow-[var(--v2-elevation-floating)] focus:outline-none"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div class={`flex flex-col p-0.5 ${props.state.listClass ?? ""}`}>
            <div class="flex h-7 items-center gap-2 rounded px-3 text-v2-icon-icon-muted">
              <Icon name="magnifying-glass" size="small" class="shrink-0" />
              <input
                ref={props.state.searchRef}
                value={props.state.search}
                placeholder={props.state.searchPlaceholder}
                class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                onInput={(event) => props.state.onSearchInput(event.currentTarget.value)}
              />
              <Show when={props.state.search.trim()}>
                <button
                  type="button"
                  class="flex size-5 items-center justify-center rounded text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                  onClick={props.state.onSearchClear}
                  aria-label={props.state.clearLabel}
                >
                  <Icon name="close-small" size="small" />
                </button>
              </Show>
            </div>
            <For each={props.state.items}>{(item) => <ComposerPickerMenuItem state={item} />}</For>
          </div>
          <div class="h-px bg-v2-border-border-muted" />
          <div class="flex flex-col p-0.5">
            <ComposerPickerMenuItem state={props.state.action} />
          </div>
        </KobaltePopover.Content>
      </KobaltePopover.Portal>
    </KobaltePopover>
  )
}

export function ComposerAgentControl(props: { state: ComposerAgentControlState }) {
  return (
    <div class="relative">
      <div class="pointer-events-none absolute left-2 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center text-v2-icon-icon-muted">
        <Icon name="sliders" size="small" />
      </div>
      <TooltipKeybind placement="top" gutter={4} title={props.state.title} keybind={props.state.keybind}>
        <Select
          size="normal"
          options={props.state.options}
          current={props.state.current}
          onSelect={props.state.onSelect}
          class="max-w-[175px] justify-start text-v2-text-text-faint [&_[data-component=icon]]:text-v2-icon-icon-muted"
          valueClass="truncate pl-5 text-[13px] font-[440] leading-5 text-v2-text-text-faint"
          triggerStyle={props.state.style}
          triggerProps={{ "data-action": "prompt-agent" }}
          variant="ghost"
        />
      </TooltipKeybind>
    </div>
  )
}

export function ComposerModelControl(props: { state: ComposerModelControlState }) {
  return (
    <Show when={!props.state.loading}>
      <Show
        when={props.state.paid}
        fallback={
          <TooltipKeybind placement="top" gutter={4} title={props.state.title} keybind={props.state.keybind}>
            <Button
              data-action="prompt-model"
              as="div"
              variant="ghost"
              size="normal"
              class="min-w-0 max-w-[220px] justify-start text-[13px] font-[440] leading-5 text-v2-text-text-faint group"
              style={props.state.style}
              onClick={props.state.onUnpaidClick}
            >
              <Show when={props.state.providerID}>
                {(providerID) => (
                  <ProviderIcon
                    id={providerID()}
                    class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                    style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                  />
                )}
              </Show>
              <span class="truncate">{props.state.modelName}</span>
              <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            </Button>
          </TooltipKeybind>
        }
      >
        <TooltipKeybind placement="top" gutter={4} title={props.state.title} keybind={props.state.keybind}>
          <ModelSelectorPopover
            model={props.state.model}
            triggerAs={Button}
            triggerProps={{
              variant: "ghost",
              size: "normal",
              style: props.state.style,
              class:
                "min-w-0 max-w-[220px] justify-start text-[13px] font-[440] leading-5 text-v2-text-text-faint group",
              "data-action": "prompt-model",
            }}
            onClose={props.state.onClose}
          >
            <Show when={props.state.providerID}>
              {(providerID) => (
                <ProviderIcon
                  id={providerID()}
                  class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                  style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                />
              )}
            </Show>
            <span class="truncate">{props.state.modelName}</span>
            <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          </ModelSelectorPopover>
        </TooltipKeybind>
      </Show>
    </Show>
  )
}
