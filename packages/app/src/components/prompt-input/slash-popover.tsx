import { Component, For, Match, Show, Switch } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"

export type AtOption =
  | { type: "agent"; name: string; display: string }
  | { type: "subagent"; name: string; display: string; description?: string }
  | { type: "file"; path: string; display: string; recent?: boolean }

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
}

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  commandKeybind: (id: string) => string | undefined
  t: (key: string) => string
}

function buildGroups(items: AtOption[], limit: number): { label: string; items: AtOption[] }[] {
  const groupMap = new Map<string, AtOption[]>()
  for (const item of items) {
    const groupKey = item.type === "subagent" ? "delegate" : item.type === "agent" ? "agent" : item.recent ? "recent" : "file"
    const label = groupKey === "agent" ? "Agents" : groupKey === "delegate" ? "Delegates" : groupKey === "recent" ? "Recent Files" : "Files"
    let group = groupMap.get(label)
    if (!group) {
      group = []
      groupMap.set(label, group)
    }
    group.push(item)
  }

  const result: { label: string; items: AtOption[] }[] = []
  let count = 0
  for (const label of groupMap.keys()) {
    const items = groupMap.get(label)!
    if (count + items.length <= limit) {
      result.push({ label, items })
      count += items.length
    } else if (count < limit) {
      result.push({ label, items: items.slice(0, limit - count) })
      break
    } else {
      break
    }
  }
  return result
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  return (
    <Show when={props.popover}>
      <div
        ref={(el) => {
          if (props.popover === "slash") props.setSlashPopoverRef(el)
        }}
        class="absolute inset-x-0 -top-2 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2 rounded-[12px]
                 bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)]"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show
              when={props.atFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyResults")}</div>}
            >
              <For each={buildGroups(props.atFlat, 10)}>
                {(group) => (
                  <>
                    <div class="text-12-regular text-text-subtle px-2 py-1 uppercase tracking-wider">{group.label}</div>
                    <For each={group.items}>
                      {(item) => {
                        const key = props.atKey(item)

                        if (item.type === "agent") {
                          return (
                            <button
                              class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
                              classList={{ "bg-surface-raised-base-hover": props.atActive === key }}
                              onClick={() => props.onAtSelect(item)}
                              onMouseEnter={() => props.setAtActive(key)}
                            >
                              <Icon name="brain" size="small" class="text-icon-info-active shrink-0" />
                              <span class="text-14-regular text-text-strong whitespace-nowrap">@{item.name}</span>
                            </button>
                          )
                        }

                        if (item.type === "subagent") {
                          return (
                            <button
                              class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
                              classList={{ "bg-surface-raised-base-hover": props.atActive === key }}
                              onClick={() => props.onAtSelect(item)}
                              onMouseEnter={() => props.setAtActive(key)}
                            >
                              <Icon name="share" size="small" class="text-icon-info-active shrink-0" />
                              <span class="text-14-regular text-text-strong whitespace-nowrap">@{item.name}</span>
                              <Show when={item.description}>
                                <span class="text-12-regular text-text-weak truncate ml-1">{item.description}</span>
                              </Show>
                            </button>
                          )
                        }

                        const isDirectory = item.path.endsWith("/")
                        const directory = isDirectory ? item.path : getDirectory(item.path)
                        const filename = isDirectory ? "" : getFilename(item.path)

                        return (
                          <button
                            class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
                            classList={{ "bg-surface-raised-base-hover": props.atActive === key }}
                            onClick={() => props.onAtSelect(item)}
                            onMouseEnter={() => props.setAtActive(key)}
                          >
                            <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-4" />
                            <div class="flex items-center text-14-regular min-w-0">
                              <span class="text-text-weak whitespace-nowrap truncate min-w-0">{directory}</span>
                              <Show when={!isDirectory}>
                                <span class="text-text-strong whitespace-nowrap">{filename}</span>
                              </Show>
                            </div>
                          </button>
                        )
                      }}
                    </For>
                  </>
                )}
              </For>
            </Show>
          </Match>
          <Match when={props.popover === "slash"}>
            <Show
              when={props.slashFlat.length > 0}
              fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyCommands")}</div>}
            >
              <For each={props.slashFlat}>
                {(cmd) => (
                  <button
                    data-slash-id={cmd.id}
                    classList={{
                      "w-full flex items-center justify-between gap-4 rounded-md px-2 py-1": true,
                      "bg-surface-raised-base-hover": props.slashActive === cmd.id,
                    }}
                    onClick={() => props.onSlashSelect(cmd)}
                    onMouseEnter={() => props.setSlashActive(cmd.id)}
                  >
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-14-regular text-text-strong whitespace-nowrap">/{cmd.trigger}</span>
                      <Show when={cmd.description}>
                        <span class="text-14-regular text-text-weak truncate">{cmd.description}</span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Show when={cmd.type === "custom" && cmd.source !== "command"}>
                        <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">
                          {cmd.source === "skill"
                            ? props.t("prompt.slash.badge.skill")
                            : cmd.source === "mcp"
                              ? props.t("prompt.slash.badge.mcp")
                              : props.t("prompt.slash.badge.custom")}
                        </span>
                      </Show>
                      <Show when={props.commandKeybind(cmd.id)}>
                        <span class="text-12-regular text-text-subtle">{props.commandKeybind(cmd.id)}</span>
                      </Show>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
