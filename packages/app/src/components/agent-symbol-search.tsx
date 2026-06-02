import { For, Show, createSignal, createMemo } from "solid-js"
import fuzzysort from "fuzzysort"

export interface Sym {
  name: string
  kind: "function" | "class" | "method" | "variable" | "import"
  file: string
  line: number
  language: string
}

export function AgentSymbolSearch() {
  const [query, setQuery] = createSignal("")

  // In production, populated from code-index projection
  const allSymbols = createMemo<Sym[]>(() => [])

  const results = createMemo(() => {
    const q = query().trim()
    if (!q) return allSymbols().slice(0, 50)
    return fuzzysort.go(q, allSymbols(), {
      keys: ["name", "file", "kind"],
      threshold: -10000,
    }).map(r => r.obj)
  })

  return (
    <div class="flex flex-col h-full bg-surface-base">
      <div class="px-3 py-2 border-b border-surface-border">
        <input
          type="text"
          placeholder="Search symbols… (functions, classes, imports)"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          class="w-full bg-surface-raised text-12-regular px-2 py-1 rounded border border-surface-border outline-none focus:border-accent"
        />
      </div>
      <div class="flex-1 overflow-auto">
        <Show when={results().length === 0 && query()}>
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">No symbols match "{query()}"</div>
        </Show>
        <Show when={results().length === 0 && !query()}>
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">
            <p>No symbols indexed yet.</p>
            <p class="mt-1">Build the code index to search symbols.</p>
          </div>
        </Show>
        <For each={results()}>
          {(sym) => (
            <div class="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover cursor-pointer text-12-regular">
              <span class="text-text-weak w-5 text-center text-11-regular">
                {sym.kind === "function" ? "ƒ" : sym.kind === "class" ? "C" : sym.kind === "import" ? "↓" : "v"}
              </span>
              <span class="flex-1 truncate font-medium">{sym.name}</span>
              <span class="text-11-regular text-text-weak truncate max-w-[40%]">{sym.file}:{sym.line}</span>
              <span class="text-10-regular text-text-weak px-1 rounded bg-surface-raised">{sym.language}</span>
            </div>
          )}
        </For>
      </div>
      <div class="px-3 py-1.5 border-t border-surface-border text-11-regular text-text-weak">
        {allSymbols().length} symbols indexed · {results().length} matching
      </div>
    </div>
  )
}
