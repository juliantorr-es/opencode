import { Component, For, Show, createMemo } from "solid-js"
import { useCommand, formatKeybind, dispatchAiCommand, type CommandOption } from "@/context/command"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { useLanguage } from "@/context/language"
import { Icon } from "@opencode-ai/ui/icon"

type IconName =
  | "align-right" | "archive" | "arrow-down-to-line" | "arrow-left" | "arrow-right"
  | "arrow-undo-down" | "arrow-up" | "brain" | "branch" | "bubble-5" | "bullet-list"
  | "check" | "check-small" | "checklist" | "chevron-double-right" | "chevron-down"
  | "chevron-grabber-vertical" | "chevron-left" | "chevron-right" | "circle-ban-sign"
  | "circle-check" | "circle-x" | "close" | "close-small" | "cloud-upload" | "code"
  | "code-lines" | "collapse" | "comment" | "console" | "copy" | "dash" | "discord"
  | "dot-grid" | "download" | "edit" | "edit-small-2" | "enter" | "expand" | "eye"
  | "file-tree" | "file-tree-active" | "folder" | "folder-add-left" | "fork"
  | "github" | "glasses" | "help" | "keyboard" | "layout-bottom" | "layout-bottom-full"
  | "layout-bottom-partial" | "layout-left" | "layout-left-full" | "layout-left-partial"
  | "layout-right" | "layout-right-full" | "layout-right-partial" | "link" | "mcp"
  | "magnifying-glass" | "magnifying-glass-menu" | "menu" | "models" | "new-session"
  | "new-session-active" | "open-file" | "pencil-line" | "photo" | "plus" | "plus-small"
  | "prompt" | "providers" | "reset" | "review" | "review-active" | "selector"
  | "server" | "settings-gear" | "share" | "shield" | "sidebar" | "sidebar-active"
  | "sliders" | "speech-bubble" | "square-arrow-top-right" | "status" | "status-active"
  | "star" | "clock" | "stop" | "task" | "terminal" | "terminal-active" | "trash" | "warning" | "window-cursor"

const AI_ICON: Record<string, IconName> = {
  "ai.explain": "code",
  "ai.refactor": "edit",
  "ai.test": "checklist",
  "ai.fix": "check",
  "ai.deploy": "cloud-upload",
  "ai.review": "glasses",
  "ai.commit": "branch",
  "ai.search": "magnifying-glass",
}

function iconFor(opt: CommandOption): IconName | undefined {
  if (opt.icon) return opt.icon as IconName
  if (opt.id.startsWith("ai.")) return AI_ICON[opt.id]
  return undefined
}

function isFilePath(text: string) {
  return /^[./~]/.test(text) || text.includes("/")
}

function inputMode(filter: string) {
  if (filter.startsWith("/")) return "ai" as const
  if (isFilePath(filter) && filter.length > 1) return "file" as const
  return "default" as const
}

export const DialogCommandPalette: Component = () => {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()

  const filtered = useFilteredList({
    items: (filter: string) => {
      const mode = inputMode(filter)

      // AI mode — only show AI action commands
      if (mode === "ai") {
        return command.options.filter((opt) => opt.id.startsWith("ai."))
      }

      // File mode — show a file search entry
      if (mode === "file") {
        return [
          {
            id: "file.search",
            title: `Search files matching "${filter}"`,
            description: "Search across the codebase for this path",
            category: "FILES",
            onSelect: () => {
              dispatchAiCommand("/search", filter)
              dialog.close()
            },
          },
        ]
      }

      // Default mode — show everything
      return command.options
    },
    key: (opt: CommandOption) => opt.id,
    filterKeys: ["title", "description", "id", "category"],
    groupBy: (opt: CommandOption) => opt.category ?? "Commands",
    sortGroupsBy: (a: { category: string }, b: { category: string }) => {
      const order = ["AI Actions", "Suggested", "FILES"]
      const ai = order.indexOf(a.category)
      const bi = order.indexOf(b.category)
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
      return a.category.localeCompare(b.category)
    },
    onSelect: (opt: CommandOption | undefined) => {
      if (!opt) return
      command.trackUse(opt.id)
      command.trigger(opt.id, "palette")
      dialog.close()
    },
  })

  const groups = () => filtered.grouped()

  const recentCommands = createMemo(() => {
    return command.recents
      .slice(0, 5)
      .map((r) => command.options.find((o) => o.id === r.id))
      .filter((o): o is NonNullable<typeof o> => o != null && !o.hidden)
  })

  const favoriteCommands = createMemo(() => {
    return command.favorites
      .map((id) => command.options.find((o) => o.id === id))
      .filter((o): o is NonNullable<typeof o> => o != null && !o.hidden)
  })

  return (
    <div
      data-component="command-palette"
      class="fixed inset-0 flex items-start justify-center pt-[15vh] z-50 pointer-events-none"
      style="transition: opacity 100ms ease"
    >
      <div class="w-full max-w-lg rounded-lg border border-border-base bg-surface-raised-stronger-non-alpha shadow-2xl overflow-hidden outline-none pointer-events-auto">
        <div class="relative">
          <input
            autofocus
            class="w-full pl-10 pr-4 py-3 text-15-regular bg-transparent border-b border-border-base outline-none placeholder:text-text-placeholder"
            placeholder={language.t("command.palette.search.placeholder")}
            value={filtered.filter()}
            onInput={(e) => filtered.onInput(e.currentTarget.value)}
            onKeyDown={(e) => filtered.onKeyDown(e)}
          />
          <Icon
            name="magnifying-glass"
            size="small"
            class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
        </div>
        <div class="max-h-80 overflow-y-auto">
          <Show
            when={groups().length > 0}
            fallback={
              <div class="px-4 py-8 text-center text-13-regular text-text-muted">
                {language.t("command.palette.empty")}
              </div>
            }
          >
            <Show when={filtered.filter().trim().length === 0 && favoriteCommands().length > 0}>
              <div>
                <div class="flex items-center gap-1.5 px-4 py-1.5 text-11-semibold uppercase tracking-wider text-text-weaker">
                  <Icon name={"star" as any} size="small" /> Favorites
                </div>
                <For each={favoriteCommands()}>
                  {(opt) => {
                    const iconName = iconFor(opt)
                    return (
                      <div
                        class="flex items-center gap-x-3 px-4 py-2 cursor-pointer text-13-regular transition-colors duration-100"
                        classList={{
                          "bg-surface-raised-base-hover text-text-base": filtered.active() === opt.id,
                          "text-text-base": filtered.active() !== opt.id,
                        }}
                        onMouseEnter={() => filtered.setActive(opt.id)}
                        onClick={() => {
                          command.trackUse(opt.id)
                          command.trigger(opt.id, "palette")
                          dialog.close()
                        }}
                      >
                        <Show when={iconName}>
                          <Icon name={iconName! as any} size="small" class="shrink-0 size-4" />
                        </Show>
                        <Show when={!iconName}>
                          <div class="shrink-0 size-4" />
                        </Show>
                        <span class="flex-1 truncate">{opt.title}</span>
                        <button
                          class="shrink-0 text-text-muted hover:text-text-base"
                          onClick={(e) => { e.stopPropagation(); command.toggleFavorite(opt.id) }}
                        >
                          <Icon name={"star" as any} size="small" />
                        </button>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
            <Show when={filtered.filter().trim().length === 0 && recentCommands().length > 0}>
              <div>
                <div class="flex items-center gap-1.5 px-4 py-1.5 text-11-semibold uppercase tracking-wider text-text-weaker">
                  <Icon name={"clock" as any} size="small" /> Recent
                </div>
                <For each={recentCommands()}>
                  {(opt) => {
                    const iconName = iconFor(opt)
                    return (
                      <div
                        class="flex items-center gap-x-3 px-4 py-2 cursor-pointer text-13-regular transition-colors duration-100"
                        classList={{
                          "bg-surface-raised-base-hover text-text-base": filtered.active() === opt.id,
                          "text-text-base": filtered.active() !== opt.id,
                        }}
                        onMouseEnter={() => filtered.setActive(opt.id)}
                        onClick={() => {
                          command.trackUse(opt.id)
                          command.trigger(opt.id, "palette")
                          dialog.close()
                        }}
                      >
                        <Show when={iconName}>
                          <Icon name={iconName! as any} size="small" class="shrink-0 size-4" />
                        </Show>
                        <Show when={!iconName}>
                          <div class="shrink-0 size-4" />
                        </Show>
                        <span class="flex-1 truncate">{opt.title}</span>
                        <Show when={opt.keybind}>
                          <span class="text-11-regular text-text-muted shrink-0">{formatKeybind(opt.keybind!, language.t)}</span>
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
            <For each={groups()}>
              {(group) => (
                <div>
                  <div class="px-4 py-1.5 text-11-semibold uppercase tracking-wider text-text-weaker">
                    {group.category}
                  </div>
                  <For each={group.items}>
                    {(opt) => {
                      const isActive = filtered.active() === opt.id
                      const iconName = iconFor(opt)
                      return (
                        <div
                          class="flex items-center gap-x-3 px-4 py-2 cursor-pointer text-13-regular transition-colors duration-100"
                          classList={{
                            "bg-surface-raised-base-hover text-text-base": isActive,
                            "text-text-base": !isActive,
                          }}
                          onMouseEnter={() => filtered.setActive(opt.id)}
                          onClick={() => {
                            command.trigger(opt.id, "palette")
                            dialog.close()
                          }}
                        >
                          <Show when={iconName}>
                            <Icon
                              name={iconName! as any}
                              size="small"
                              class="shrink-0 size-4"
                            />
                          </Show>
                          <Show when={!iconName}>
                            <div class="shrink-0 size-4" />
                          </Show>
                          <div class="flex-1 min-w-0">
                            <div class="truncate">{opt.title}</div>
                            <Show when={opt.description}>
                              <div class="text-12-regular text-text-muted truncate">
                                {opt.description}
                              </div>
                            </Show>
                          </div>
                          <Show when={opt.keybind}>
                            <span class="text-11-regular text-text-muted shrink-0">
                              {formatKeybind(opt.keybind!, language.t)}
                            </span>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )
}
