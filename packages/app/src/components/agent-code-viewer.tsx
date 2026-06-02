import { For, Show, createSignal, createMemo } from "solid-js"

interface CodeSymbol {
  name: string
  kind: "function" | "class" | "method" | "variable" | "import"
  line: number
}

export function AgentCodeViewer(props: {
  fileName?: string
  content?: string
  language?: string
  symbols?: CodeSymbol[]
  highlightedLines?: number[] // changed or claimed lines
}) {
  const [showSymbols, setShowSymbols] = createSignal(true)

  const lines = createMemo(() => (props.content ?? "").split("\n"))

  return (
    <div class="flex h-full bg-surface-base">
      {/* Symbol outline sidebar */}
      <Show when={showSymbols() && (props.symbols?.length ?? 0) > 0}>
        <div class="w-48 border-r border-surface-border overflow-auto flex-shrink-0">
          <div class="px-2 py-1 text-11-regular text-text-weak uppercase tracking-wider">Symbols</div>
          <For each={props.symbols}>
            {(sym) => (
              <div
                class="px-2 py-0.5 text-12-regular hover:bg-surface-hover cursor-pointer flex items-center gap-1.5"
                onClick={() => {
                  const el = document.getElementById(`line-${sym.line}`)
                  el?.scrollIntoView({ block: "center" })
                }}
              >
                <span class="text-11-regular text-text-weak w-5 text-right">{sym.line}</span>
                <span class="text-text-weak">{sym.kind === "function" ? "ƒ" : sym.kind === "class" ? "C" : sym.kind === "import" ? "↓" : "v"}</span>
                <span class="truncate">{sym.name}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Code content */}
      <div class="flex-1 overflow-auto">
        <div class="flex items-center justify-between px-3 py-1.5 border-b border-surface-border sticky top-0 bg-surface-base">
          <span class="text-13-regular font-medium truncate">{props.fileName ?? "Code Viewer"}</span>
          <div class="flex gap-1">
            <button class="text-11-regular text-text-weak hover:text-text-base px-2 py-0.5" onClick={() => copyContent(props.content)}>Copy</button>
            {props.symbols && props.symbols.length > 0 && (
              <button class={`text-11-regular px-2 py-0.5 ${showSymbols() ? "text-accent" : "text-text-weak"}`} onClick={() => setShowSymbols(!showSymbols())}>
                Symbols
              </button>
            )}
          </div>
        </div>
        <div class="font-mono text-12-regular leading-5">
          <Show when={!props.content}>
            <div class="px-3 py-6 text-center text-text-weak">Select a file to view</div>
          </Show>
          <For each={lines()}>
            {(line, i) => {
              const isHighlighted = props.highlightedLines?.includes(i() + 1)
              return (
                <div
                  id={`line-${i() + 1}`}
                  class={`flex hover:bg-surface-hover ${isHighlighted ? "bg-accent/5 border-l-2 border-accent" : ""}`}
                >
                  <span class="w-10 text-right pr-2 text-11-regular text-text-weak select-none flex-shrink-0 pt-px">{i() + 1}</span>
                  <span class="whitespace-pre flex-1">{line}</span>
                </div>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}

async function copyContent(text?: string) {
  if (!text) return
  await navigator.clipboard.writeText(text)
}
