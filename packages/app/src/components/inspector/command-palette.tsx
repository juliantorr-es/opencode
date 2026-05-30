import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import fuzzysort from "fuzzysort"
import { useCommand, dispatchAiCommand, type CommandOption } from "@/context/command"
import { Icon } from "@opencode-ai/ui/icon"
import { useInspector } from "@/context/inspector"

type PaletteCommand = CommandOption & {
  icon?: string
  category: string
  keywords?: string
}

const IS_MAC =
  typeof navigator === "object" &&
  /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

// ── Command definitions ──

const COMMANDS: PaletteCommand[] = [
  // Testing
  {
    id: "inspector.run-tests",
    title: "Run tests for changed files",
    description: "Execute tests scoped to files modified in this session",
    icon: "checklist",
    category: "Testing",
    keywords: "test changed run",
    onSelect: () => dispatchAiCommand("run-tests", "changed"),
  },
  // Git
  {
    id: "inspector.explain-diff",
    title: "Explain current diff",
    description: "Summarize unstaged and staged changes in natural language",
    icon: "code-lines",
    category: "Git",
    keywords: "diff git explain changes",
    onSelect: () => dispatchAiCommand("explain-diff"),
  },
  {
    id: "inspector.revert-last-edit",
    title: "Revert last agent edit",
    description: "Undo the most recent agent-applied code change",
    icon: "arrow-undo-down",
    category: "Git",
    keywords: "undo revert rollback agent",
    onSelect: () => dispatchAiCommand("revert-last"),
  },
  // Checkpoint
  {
    id: "inspector.checkpoint-now",
    title: "Checkpoint now",
    description: "Save a snapshot of current work for rollback",
    icon: "cloud-upload",
    category: "Checkpoint",
    keywords: "save snapshot checkpoint commit",
    onSelect: () => dispatchAiCommand("checkpoint"),
  },
  // Inspector
  {
    id: "inspector.show-claims",
    title: "Show file claims",
    description: "Display lane-based file ownership and claims for active files",
    icon: "shield",
    category: "Inspector",
    keywords: "claims file ownership lanes",
    onSelect: () => dispatchAiCommand("show-claims"),
  },
  {
    id: "inspector.show-failed-tools",
    title: "Show failed tools",
    description: "List all tool invocations that failed with errors",
    icon: "warning",
    category: "Inspector",
    keywords: "failed errors tools failures",
    onSelect: () => dispatchAiCommand("show-failed"),
  },
  {
    id: "inspector.event-timeline",
    title: "Open event timeline",
    description: "Switch to or focus the event inspector timeline",
    icon: "clock",
    category: "Inspector",
    keywords: "timeline events inspector history",
    onSelect: () => dispatchAiCommand("focus-timeline"),
  },
  // Agent
  {
    id: "inspector.continue-from-error",
    title: "Ask agent to continue from selected error",
    description: "Feed the selected event or error back to the agent as context",
    icon: "arrow-right",
    category: "Agent",
    keywords: "continue error retry agent",
    onSelect: () => dispatchAiCommand("continue-from-error"),
  },
  {
    id: "inspector.switch-model",
    title: "Switch model",
    description: "Open the model/provider selection dialog",
    icon: "models",
    category: "Agent",
    keywords: "model provider switch change llm",
    onSelect: () => dispatchAiCommand("switch-model"),
  },
  // Workflow
  {
    id: "inspector.plan-only",
    title: "Make plan only",
    description: "Generate a plan without executing any edits",
    icon: "pencil-line",
    category: "Workflow",
    keywords: "plan only no execute",
    onSelect: () => dispatchAiCommand("mode", "plan"),
  },
  {
    id: "inspector.patch-only",
    title: "Apply patch only",
    description: "Execute the pending plan diff without re-planning",
    icon: "code",
    category: "Workflow",
    keywords: "patch apply execute skip plan",
    onSelect: () => dispatchAiCommand("mode", "patch"),
  },
  {
    id: "inspector.stop-after-next",
    title: "Stop after next tool",
    description: "Set a breakpoint so the agent pauses after the next tool call",
    icon: "stop",
    category: "Workflow",
    keywords: "breakpoint stop pause tool",
    onSelect: () => dispatchAiCommand("stop-after-next"),
  },
  // Debug
  {
    id: "inspector.export-debug-packet",
    title: "Export debug packet",
    description: "Bundle session events, logs, and state into a debug archive",
    icon: "download",
    category: "Debug",
    keywords: "export debug packet bundle logs",
    onSelect: () => dispatchAiCommand("export-debug"),
  },
  {
    id: "inspector.generate-pr-description",
    title: "Generate PR description",
    description: "Auto-generate a pull request description from the current diff",
    icon: "branch",
    category: "Debug",
    keywords: "pr pull request description generate",
    onSelect: () => dispatchAiCommand("generate-pr"),
  },
]

// ── Fuzzysort helpers ──

function fuzzyFilter(query: string, commands: PaletteCommand[]) {
  const q = query.trim().toLowerCase()
  if (!q) return commands

  // Search across title + keywords
  const results = fuzzysort.go(q, commands, {
    keys: ["title", "keywords", "description"],
    threshold: -10000,
    limit: 50,
  })

  return results.map((r) => r.obj)
}

// ── Context snapshot ──

function captureContext() {
  const sel = window.getSelection()
  const text = sel && sel.toString().trim()
  return {
    hasSelection: !!text,
    selectedText: text && text.length > 120 ? text.slice(0, 120) + "\u2026" : text ?? null,
  }
}

// ── Category ordering ──

const CATEGORY_ORDER = [
  "Testing",
  "Git",
  "Checkpoint",
  "Inspector",
  "Agent",
  "Workflow",
  "Debug",
]

function groupByCategory(cmds: PaletteCommand[]): Map<string, PaletteCommand[]> {
  const groups = new Map<string, PaletteCommand[]>()
  for (const cmd of cmds) {
    const cat = cmd.category
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(cmd)
  }
  // Sort by category order, unknown categories at end
  const ordered = new Map<string, PaletteCommand[]>()
  for (const cat of CATEGORY_ORDER) {
    if (groups.has(cat)) {
      ordered.set(cat, groups.get(cat)!)
      groups.delete(cat)
    }
  }
  for (const [cat, items] of groups) {
    ordered.set(cat, items)
  }
  return ordered
}

// ── Component ──

export const CommandPalette: Component = () => {
  const command = useCommand()
  let inputRef!: HTMLInputElement
  let listRef!: HTMLDivElement

  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [activeIndex, setActiveIndex] = createSignal(0)
  const [context, setContext] = createStore(captureContext())

  // Try to grab inspector context if available (may not be inside InspectorProvider)
  let inspector: ReturnType<typeof useInspector> | null = null
  try {
    inspector = useInspector()
  } catch {
    // not inside InspectorProvider — that's fine
  }

  // ── Register commands with the existing command infrastructure ──

  onMount(() => {
    command.register(() =>
      COMMANDS.map(
        (cmd): CommandOption => ({
          ...cmd,
          onSelect: (source) => {
            command.trackUse(cmd.id)
            cmd.onSelect?.(source)
          },
        }),
      ),
    )
  })

  // ── Global keybind: Cmd+K / Ctrl+K ──

  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey
      if (mod && e.key === "k") {
        e.preventDefault()
        e.stopPropagation()
        // Refresh context on open
        setContext(captureContext())
        setOpen((o) => !o)
        if (!open()) setQuery("")
      }
      if (e.key === "Escape" && open()) {
        setOpen(false)
      }
    }
    window.addEventListener("keydown", handler, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", handler, { capture: true }))
  })

  // Focus input on open
  createEffect(() => {
    if (open() && inputRef) {
      requestAnimationFrame(() => inputRef.focus())
    }
  })

  // Reset active index when list changes
  createEffect(() => {
    filtered()
    setActiveIndex(0)
  })

  // ── Close on backdrop click ──

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) setOpen(false)
  }

  // ── Filtered list ──

  const filtered = createMemo(() => {
    const items = fuzzyFilter(query(), COMMANDS)
    return {
      groups: groupByCategory(items),
      all: items,
    }
  })

  const flatItems = createMemo(() => {
    const entries: { cmd: PaletteCommand; category: string }[] = []
    for (const [cat, cmds] of filtered().groups) {
      for (const cmd of cmds) entries.push({ cmd, category: cat })
    }
    return entries
  })

  // ── Keyboard navigation ──

  function onKeyDown(e: KeyboardEvent) {
    const items = flatItems()

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % Math.max(items.length, 1))
        break
      }
      case "ArrowUp": {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1))
        break
      }
      case "Enter": {
        e.preventDefault()
        const idx = activeIndex()
        if (items[idx]) {
          execute(items[idx].cmd)
        }
        break
      }
      case "Escape": {
        e.preventDefault()
        setOpen(false)
        break
      }
    }
  }

  function execute(cmd: PaletteCommand) {
    command.trackUse(cmd.id)
    cmd.onSelect?.("palette")
    setOpen(false)
  }

  // Auto-scroll active item into view
  createEffect(() => {
    if (!listRef) return
    const item = listRef.querySelector(`[data-index="${activeIndex()}"]`)
    if (item) item.scrollIntoView({ block: "nearest" })
  })

  const hasContext = () => context.hasSelection || inspector?.selectedEvent()

  return (
    <Show when={open()}>
      <Portal>
        {/* Backdrop */}
        <div
          class="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
          style="background: rgba(0,0,0,0.4)"
          onClick={onBackdropClick}
        >
          {/* Panel */}
          <div
            class="w-full max-w-lg rounded-lg border border-border-base bg-surface-raised-stronger-non-alpha shadow-2xl outline-none"
            style="max-height: min(60vh, 500px); display: flex; flex-direction: column;"
          >
            {/* Search input */}
            <div class="relative shrink-0">
              <input
                ref={inputRef!}
                class="w-full pl-10 pr-16 py-3 text-15-regular bg-transparent border-b border-border-base outline-none placeholder:text-text-placeholder"
                placeholder="Search commands\u2026"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={onKeyDown}
              />
              <Icon
                name="magnifying-glass"
                size="small"
                class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
              />
              <div class="absolute right-3 top-1/2 -translate-y-1/2 text-11-regular text-text-muted pointer-events-none">
                <Show
                  when={query().length === 0}
                  fallback={<span>{flatItems().length}</span>}
                >
                  <span class="px-1.5 py-0.5 rounded bg-surface-raised-base text-10">
                    {IS_MAC ? "\u2318K" : "Ctrl+K"}
                  </span>
                </Show>
              </div>
            </div>

            {/* Context pill */}
            <Show when={hasContext()}>
              <div class="shrink-0 px-4 py-1.5 text-11-regular text-text-muted border-b border-border-base flex items-center gap-2">
                <Icon name="selector" size="small" class="shrink-0" />
                <Show when={context.hasSelection}>
                  <span class="truncate">{context.selectedText}</span>
                </Show>
                <Show when={!context.hasSelection && inspector?.selectedEvent()}>
                  <span class="truncate">
                    Event: {inspector?.selectedEvent()?.type}
                  </span>
                </Show>
              </div>
            </Show>

            {/* Results list */}
            <div ref={listRef!} class="flex-1 overflow-y-auto">
              <Show
                when={flatItems().length > 0}
                fallback={
                  <div class="px-4 py-8 text-center text-13-regular text-text-muted">
                    No matching commands
                  </div>
                }
              >
                <For each={Array.from(filtered().groups.entries())}>
                  {([category, cmds]) => (
                    <div>
                      <div class="px-4 py-1.5 text-11-semibold uppercase tracking-wider text-text-weaker">
                        {category}
                      </div>
                      <For each={cmds}>
                        {(cmd) => {
                          const idx = flatItems().findIndex(
                            (f) => f.cmd.id === cmd.id,
                          )
                          const isActive = activeIndex() === idx
                          return (
                            <div
                              data-index={idx}
                              class="flex items-center gap-x-3 px-4 py-2 cursor-pointer text-13-regular transition-colors duration-100"
                              classList={{
                                "bg-surface-raised-base-hover text-text-base": isActive,
                                "text-text-base": !isActive,
                              }}
                              onMouseEnter={() => setActiveIndex(idx)}
                              onClick={() => execute(cmd)}
                            >
                              <Show when={cmd.icon}>
                                <Icon
                                  name={cmd.icon as any}
                                  size="small"
                                  class="shrink-0 size-4"
                                />
                              </Show>
                              <Show when={!cmd.icon}>
                                <div class="shrink-0 size-4" />
                              </Show>
                              <div class="flex-1 min-w-0">
                                <div class="truncate">
                                  <Highlight text={cmd.title} query={query()} />
                                </div>
                                <Show when={cmd.description}>
                                  <div class="text-12-regular text-text-muted truncate">
                                    {cmd.description}
                                  </div>
                                </Show>
                              </div>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  )}
                </For>
              </Show>
            </div>

            {/* Footer hints */}
            <div class="shrink-0 flex items-center gap-3 px-4 py-1.5 border-t border-border-base text-11-regular text-text-muted">
              <span>
                <kbd class="px-1 py-0.5 rounded bg-surface-raised-base text-text-weaker text-10">
                  {IS_MAC ? "\u2191" : "\u2191"}
                </kbd>
                <kbd class="px-1 py-0.5 rounded bg-surface-raised-base text-text-weaker text-10 ml-0.5">
                  {IS_MAC ? "\u2193" : "\u2193"}
                </kbd>{" "}
                navigate
              </span>
              <span>
                <kbd class="px-1 py-0.5 rounded bg-surface-raised-base text-text-weaker text-10">
                  {IS_MAC ? "\u23CE" : "Enter"}
                </kbd>{" "}
                select
              </span>
              <span>
                <kbd class="px-1 py-0.5 rounded bg-surface-raised-base text-text-weaker text-10">
                  Esc
                </kbd>{" "}
                close
              </span>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}

// ── Highlight component ──

function Highlight(props: { text: string; query: string }) {
  const matches = createMemo(() => {
    const q = props.query.trim()
    if (!q) return null
    try {
      return fuzzysort.single(q, fuzzysort.prepare(props.text))
    } catch {
      return null
    }
  })

  return (
    <Show
      when={matches()}
      fallback={<span>{props.text}</span>}
    >
      <span>{highlightText(props.text, matches()!.indexes.slice())}</span>
    </Show>
  )
}

function highlightText(text: string, indexes: number[]) {
  if (!indexes || indexes.length === 0) return text

  const indexSet = new Set(indexes)
  const parts: { matched: boolean; char: string }[] = []

  for (let i = 0; i < text.length; i++) {
    parts.push({
      matched: indexSet.has(i),
      char: text[i],
    })
  }

  // Merge consecutive matched/unmatched runs
  const merged: { matched: boolean; text: string }[] = []
  for (const part of parts) {
    const last = merged[merged.length - 1]
    if (last && last.matched === part.matched) {
      last.text += part.char
    } else {
      merged.push({ matched: part.matched, text: part.char })
    }
  }

  return merged.map((seg, i) =>
    seg.matched ? (
      <span class="text-text-base font-medium">{seg.text}</span>
    ) : (
      <span>{seg.text}</span>
    ),
  )
}
