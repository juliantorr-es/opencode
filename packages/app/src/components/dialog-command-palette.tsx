import { Component, For, Show } from "solid-js"
import { useCommand, formatKeybind } from "@/context/command"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { useLanguage } from "@/context/language"

export const DialogCommandPalette: Component = () => {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()

  const filtered = useFilteredList({
    items: () => command.options,
    key: (opt) => opt.id,
    filterKeys: ["id", "title", "description", "category"],
    groupBy: (opt) => opt.category ?? "",
    sortBy: (a, b) => a.title.localeCompare(b.title),
    onSelect: (opt) => {
      if (!opt) return
      command.trigger(opt.id, "palette")
      dialog.close()
    },
  })

  const groups = () => filtered.grouped()

  return (
    <div data-component="command-palette" class="fixed inset-0 flex items-start justify-center pt-[15vh] z-50 pointer-events-none">
      <div class="w-full max-w-lg rounded-lg border border-border-base bg-surface-raised-stronger-non-alpha shadow-2xl overflow-hidden outline-none pointer-events-auto">
        <input
          autofocus
          class="w-full px-4 py-3 text-15-regular bg-transparent border-b border-border-base outline-none placeholder:text-text-placeholder"
          placeholder={language.t("command.palette.search.placeholder")}
          value={filtered.filter()}
          onInput={(e) => filtered.onInput(e.currentTarget.value)}
          onKeyDown={(e) => filtered.onKeyDown(e)}
        />
        <div class="max-h-80 overflow-y-auto">
          <Show when={groups().length > 0} fallback={
            <div class="px-4 py-8 text-center text-13-regular text-text-muted">
              {language.t("command.palette.empty")}
            </div>
          }>
            <For each={groups()}>
              {(group) => (
                <div>
                  <div class="px-4 py-1.5 text-11-semibold uppercase tracking-wider text-text-muted">
                    {group.category}
                  </div>
                  <For each={group.items}>
                    {(opt) => {
                      const isActive = filtered.active() === opt.id
                      return (
                        <div
                          class="flex items-center gap-x-3 px-4 py-2 cursor-pointer text-13-regular"
                          classList={{
                            "bg-accent-bg text-text-base": isActive,
                            "text-text-base": !isActive,
                          }}
                          onMouseEnter={() => filtered.setActive(opt.id)}
                          onClick={() => {
                            command.trigger(opt.id, "palette")
                            dialog.close()
                          }}
                        >
                          <span class="flex-1 truncate">{opt.title}</span>
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
