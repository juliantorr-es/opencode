import { Component, For, Show, createMemo, createSignal } from "solid-js"
import { formatKeybind, dispatchAiCommand, type CommandOption, type CommandUsageRecord } from "@/context/command"
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

type PaletteOption = CommandOption & { category?: string }

export const DialogCommandPalette: Component<{
  options: CommandOption[]
  recents: CommandUsageRecord[]
  favorites: string[]
  t: (key: string) => string
  trackUse: (id: string) => void
  trigger: (id: string, source: "palette" | "keybind" | "slash") => void
  close: () => void
}> = (props) => {
  console.debug("[palette] render start")
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal<string | null>(null)

  const filtered = createMemo(() => {
    const filter = query().trim().toLowerCase()
    const mode = inputMode(query())
    const base: PaletteOption[] =
      mode === "ai"
        ? props.options.filter((opt) => opt.id.startsWith("ai."))
        : mode === "file"
          ? [
              {
                id: "file.search",
                title: `Search files matching "${query()}"`,
                description: "Search across the codebase for this path",
                category: "FILES",
                onSelect: () => {
                  dispatchAiCommand("/search", query())
                  props.close()
                },
              },
            ]
          : props.options

    const items = base.filter((opt) => {
      if (!filter) return true
      return [opt.title, opt.description, opt.id, opt.category, opt.slash]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(filter))
    })

    const groups = new Map<string, PaletteOption[]>()
    for (const opt of items) {
      const category = opt.category ?? "Commands"
      const list = groups.get(category)
      if (list) list.push(opt)
      else groups.set(category, [opt])
    }

    return [...groups.entries()]
      .map(([category, items]) => ({
        category,
        items: items.slice().sort((a, b) => a.title.localeCompare(b.title)),
      }))
      .sort((a, b) => {
        const order = ["AI Actions", "Suggested", "FILES"]
        const ai = order.indexOf(a.category)
        const bi = order.indexOf(b.category)
        if (ai !== -1 && bi !== -1) return ai - bi
        if (ai !== -1) return -1
        if (bi !== -1) return 1
        return a.category.localeCompare(b.category)
      })
  })

  const allItems = createMemo(() => filtered().flatMap((group) => group.items))
  const recentCommands = createMemo(() => {
    return props.recents
      .slice(0, 5)
      .map((r) => props.options.find((o) => o.id === r.id))
      .filter((o): o is NonNullable<typeof o> => o != null && !o.hidden)
  })
  const favoriteCommands = createMemo(() => {
    return props.favorites
      .map((id) => props.options.find((o) => o.id === id))
      .filter((o): o is NonNullable<typeof o> => o != null && !o.hidden)
  })

  const activateFirst = () => {
    const first = allItems()[0]
    if (first) setActive(first.id)
  }

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
            placeholder={props.t("command.palette.search.placeholder")}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              queueMicrotask(activateFirst)
            }}
            onKeyDown={(e) => {
              const items = allItems()
              if (e.key === "Enter") {
                const selected = items.find((opt) => opt.id === active()) ?? items[0]
                if (!selected) return
                if (selected.onSelect) {
                  selected.onSelect()
                } else {
                  props.trackUse(selected.id)
                  props.trigger(selected.id, "palette")
                  props.close()
                }
                return
              }
              if (e.key === "ArrowDown") {
                if (!items.length) return
                const index = Math.max(0, items.findIndex((opt) => opt.id === active()))
                const next = items[Math.min(items.length - 1, index + 1)]
                setActive(next.id)
                e.preventDefault()
                return
              }
              if (e.key === "ArrowUp") {
                if (!items.length) return
                const index = Math.max(0, items.findIndex((opt) => opt.id === active()))
                const next = items[Math.max(0, index - 1)]
                setActive(next.id)
                e.preventDefault()
              }
            }}
          />
          <Icon
            name="magnifying-glass"
            size="small"
            class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
        </div>
        <div class="max-h-80 overflow-y-auto">
          <Show
            when={filtered().length > 0}
            fallback={
              <div class="px-4 py-8 text-center text-13-regular text-text-muted">
                {props.t("command.palette.empty")}
              </div>
            }
          >
            <Show when={query().trim().length === 0 && favoriteCommands().length > 0}>
              <div>
                <div class="flex items-center gap-1.5 px-4 py-1.5 text-11-semibold uppercase tracking-wider text-text-weaker">
                  <Icon name={"star" as any} size="small" /> Favorites
                </div>
                <For each={favoriteCommands()}>
                  {(opt) => (
                    <PaletteRow
                      opt={opt}
                      iconName={iconFor(opt)}
                      t={props.t}
                      active={active}
                      setActive={setActive}
                      onSelect={() => {
                        props.trackUse(opt.id)
                        props.trigger(opt.id, "palette")
                        props.close()
                      }}
                    />
                  )}
                </For>
              </div>
            </Show>
            <Show when={query().trim().length === 0 && recentCommands().length > 0}>
              <div>
                <div class="flex items-center gap-1.5 px-4 py-1.5 text-11-semibold uppercase tracking-wider text-text-weaker">
                  <Icon name={"clock" as any} size="small" /> Recent
                </div>
                <For each={recentCommands()}>
                  {(opt) => (
                    <PaletteRow
                      opt={opt}
                      iconName={iconFor(opt)}
                      t={props.t}
                      active={active}
                      setActive={setActive}
                      onSelect={() => {
                        props.trackUse(opt.id)
                        props.trigger(opt.id, "palette")
                        props.close()
                      }}
                    />
                  )}
                </For>
              </div>
            </Show>
            <For each={filtered()}>
              {(group) => (
                <div>
                  <div class="px-4 py-1.5 text-11-semibold uppercase tracking-wider text-text-weaker">
                    {group.category}
                  </div>
                  <For each={group.items}>
                    {(opt) => (
                      <PaletteRow
                        opt={opt}
                        iconName={iconFor(opt)}
                        t={props.t}
                        active={active}
                        setActive={setActive}
                        onSelect={() => {
                          if (opt.onSelect) opt.onSelect()
                          else {
                            props.trackUse(opt.id)
                            props.trigger(opt.id, "palette")
                            props.close()
                          }
                        }}
                      />
                    )}
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

function PaletteRow(props: {
  opt: PaletteOption
  iconName: IconName | undefined
  t: (key: string) => string
  active: () => string | null
  setActive: (id: string) => void
  onSelect: () => void
}) {
  return (
    <div
      class="flex items-center gap-x-3 px-4 py-2 cursor-pointer text-13-regular transition-colors duration-100"
      classList={{
        "bg-surface-raised-base-hover text-text-base": props.active() === props.opt.id,
        "text-text-base": props.active() !== props.opt.id,
      }}
      onMouseEnter={() => props.setActive(props.opt.id)}
      onClick={props.onSelect}
    >
      <Show when={props.iconName}>
        <Icon name={props.iconName! as any} size="small" class="shrink-0 size-4" />
      </Show>
      <Show when={!props.iconName}>
        <div class="shrink-0 size-4" />
      </Show>
      <span class="flex-1 truncate">{props.opt.title}</span>
      <Show when={props.opt.keybind}>
        <span class="text-11-regular text-text-muted shrink-0">{formatKeybind(props.opt.keybind!, props.t)}</span>
      </Show>
    </div>
  )
}
