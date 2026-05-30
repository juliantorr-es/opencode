import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { KeybindV2 } from "@opencode-ai/ui/v2/components/keybind-v2.jsx"
import { parseKeybind } from "@/context/command"
import type { CommandOption } from "@/context/command"

/**
 * Display order for command categories in the overlay.
 * Categories not in this list appear at the end (sorted alphabetically).
 */
const CATEGORY_ORDER = [
  "Session",
  "View",
  "Project",
  "Workspace",
  "Theme",
  "Language",
  "Settings",
  "Provider",
  "Server",
  "File",
  "Context",
  "Terminal",
  "Model",
  "MCP",
  "Agent",
  "Permissions",
]

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

function categorySortKey(cat: string | undefined): number {
  if (!cat) return 999
  const idx = CATEGORY_ORDER.indexOf(cat)
  return idx >= 0 ? idx : 99
}

/**
 * Parse a keybind config string into individual key labels for KeybindV2.
 * Mirrors the logic of formatKeybind() but returns an array instead of a formatted string.
 */
function keybindParts(config: string): string[] {
  if (!config || config === "none") return []
  const keybinds = parseKeybind(config)
  if (keybinds.length === 0) return []
  const kb = keybinds[0]
  const parts: string[] = []

  if (kb.ctrl) parts.push(IS_MAC ? "⌃" : "Ctrl")
  if (kb.alt) parts.push(IS_MAC ? "⌥" : "Alt")
  if (kb.shift) parts.push(IS_MAC ? "⇧" : "Shift")
  if (kb.meta) parts.push(IS_MAC ? "⌘" : "Cmd")

  if (kb.key) {
    const keys: Record<string, string> = {
      arrowup: "↑",
      arrowdown: "↓",
      arrowleft: "←",
      arrowright: "→",
      comma: ",",
      plus: "+",
      space: "Space",
    }
    const named: Record<string, string> = {
      backspace: "⌫",
      delete: "⌦",
      end: "End",
      enter: "↵",
      esc: "Esc",
      escape: "Esc",
      home: "Home",
      insert: "Ins",
      pagedown: "PgDn",
      pageup: "PgUp",
      tab: "Tab",
    }
    const key = kb.key.toLowerCase()
    const display =
      keys[key] ??
      named[key] ??
      (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1))
    parts.push(display)
  }

  return parts
}

export interface KeyHintOverlayProps {
  /** Command context from useCommand(). Pass at least { options: CommandOption[] } */
  command: {
    options: CommandOption[]
  }
  /** Whether the overlay is currently visible */
  visible: boolean
  /** Called when the overlay should close (backdrop click, escape, modifier release) */
  onClose: () => void
}

export function KeyHintOverlay(props: KeyHintOverlayProps) {
  // Group commands by category, filtering out hidden/disabled/keybindless entries
  const grouped = createMemo(() => {
    const groups = new Map<string, CommandOption[]>()
    for (const opt of props.command.options) {
      if (opt.hidden || opt.disabled || !opt.keybind || opt.keybind === "none") continue
      if (opt.id.startsWith("suggested.")) continue
      const category = opt.category ?? "Other"
      if (!groups.has(category)) groups.set(category, [])
      groups.get(category)!.push(opt)
    }
    for (const [, cmds] of groups) {
      cmds.sort((a, b) => a.title.localeCompare(b.title))
    }
    return groups
  })

  // Sorted category list
  const categories = createMemo(() => {
    return [...grouped().keys()].sort((a, b) => categorySortKey(a) - categorySortKey(b))
  })

  // Dismiss on Escape key when overlay is visible
  createEffect(() => {
    if (!props.visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        props.onClose()
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  return (
    <Show when={props.visible}>
      <div
        class="fixed inset-0 z-[9999] flex items-start justify-center pt-24 overflow-y-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
        style={{ "animation": "fadeIn 120ms ease-out" }}
      >
        {/* Scrim backdrop */}
        <div class="fixed inset-0 bg-black/30" />

        {/* Panel */}
        <div
          class="relative min-w-[400px] max-w-[520px] w-full mx-4 rounded-xl overflow-hidden"
          style={{
            "box-shadow": "var(--v2-elevation-overlay, 0 16px 32px rgba(0,0,0,0.12))",
            background: "var(--v2-background-bg-layer-01, var(--background-base, #1a1a1a))",
            border: "1px solid var(--v2-border-border-base, var(--border-weaker-base, rgba(255,255,255,0.08)))",
          }}
        >
          {/* Header */}
          <div
            class="flex items-center justify-between px-4 py-2.5"
            style={{
              "border-bottom": "1px solid var(--v2-border-border-muted, var(--border-weaker-base, rgba(255,255,255,0.06)))",
            }}
          >
            <span
              class="text-14-medium"
              style={{ color: "var(--v2-text-text-base, var(--text-strong, #eee))" }}
            >
              Keyboard Shortcuts
            </span>
            <button
              onClick={props.onClose}
              class="flex items-center justify-center size-6 rounded-md"
              style={{
                color: "var(--v2-text-text-muted, var(--text-muted, #888))",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background =
                  "var(--v2-overlay-simple-overlay-hover, rgba(255,255,255,0.06))"
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent"
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>

          {/* Body */}
          <div class="p-2 max-h-[55vh] overflow-y-auto">
            <For each={categories()}>
              {(category) => (
                <div class="mb-2 last:mb-0">
                  <div
                    class="px-2 py-1 text-12-medium uppercase tracking-wider"
                    style={{ color: "var(--v2-text-text-faint, var(--text-faint, #666))" }}
                  >
                    {category}
                  </div>
                  <For each={grouped().get(category)}>
                    {(cmd) => (
                      <div
                        class="flex items-center justify-between px-2 py-1.5 rounded-md cursor-default"
                        style={{ color: "var(--v2-text-text-base, var(--text-strong, #eee))" }}
                        onMouseEnter={(e) => {
                          ;(e.currentTarget as HTMLElement).style.background =
                            "var(--v2-overlay-simple-overlay-hover, rgba(255,255,255,0.04))"
                        }}
                        onMouseLeave={(e) => {
                          ;(e.currentTarget as HTMLElement).style.background = "transparent"
                        }}
                      >
                        <span class="text-14-regular truncate mr-4">{cmd.title}</span>
                        <KeybindV2 keys={keybindParts(cmd.keybind!)} variant="ghost" />
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>

          {/* Footer hint */}
          <div
            class="px-4 py-2"
            style={{
              color: "var(--v2-text-text-faint, var(--text-faint, #666))",
              "border-top": "1px solid var(--v2-border-border-muted, var(--border-weaker-base, rgba(255,255,255,0.06)))",
              "font-size": "12px",
            }}
          >
            Release modifier key to dismiss &middot; Customize in Settings
          </div>
        </div>
      </div>

      {/* Global style for the fade-in animation */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </Show>
  )
}
