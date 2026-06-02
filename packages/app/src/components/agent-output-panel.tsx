import { For, Show, createSignal, createMemo } from "solid-js"

interface OutputLine {
  text: string
  stream: "stdout" | "stderr"
  timestamp: number
  source: "typecheck" | "test" | "build" | "migration" | "tool" | "sidecar" | "boot"
  agentName?: string
}

export function AgentOutputPanel() {
  const [filter, setFilter] = createSignal<OutputLine["source"] | "all">("all")
  const [lines, setLines] = createSignal<OutputLine[]>([])

  const filtered = createMemo(() =>
    filter() === "all" ? lines() : lines().filter(l => l.source === filter())
  )

  const sources = createMemo(() => {
    const set = new Set(lines().map(l => l.source))
    return ["all", ...set] as (OutputLine["source"] | "all")[]
  })

  return (
    <div class="flex flex-col h-full bg-surface-base">
      <div class="flex items-center gap-1 px-3 py-1.5 border-b border-surface-border overflow-x-auto">
        <For each={sources()}>
          {(src) => (
            <button
              class={`px-2 py-0.5 text-11-regular rounded whitespace-nowrap ${filter() === src ? "bg-surface-raised text-text-base" : "text-text-weak"}`}
              onClick={() => setFilter(src)}
            >
              {src}
            </button>
          )}
        </For>
      </div>
      <div class="flex-1 overflow-auto font-mono text-11-regular leading-4">
        <Show when={filtered().length === 0}>
          <div class="px-3 py-6 text-center text-text-weak">
            <p>No output yet.</p>
            <p class="mt-1">Run a task to see output here.</p>
          </div>
        </Show>
        <For each={filtered()}>
          {(line) => (
            <div class={`flex px-3 py-0.5 hover:bg-surface-hover ${line.stream === "stderr" ? "text-danger" : "text-text-base"}`}>
              <span class="w-16 text-text-weak flex-shrink-0 text-10-regular">{formatTime(line.timestamp)}</span>
              <span class="w-14 text-text-weak flex-shrink-0 text-10-regular">{line.source}</span>
              {line.agentName && <span class="text-accent mr-1 text-10-regular">{line.agentName}</span>}
              <span class="whitespace-pre-wrap break-all">{line.text}</span>
            </div>
          )}
        </For>
      </div>
      <div class="flex items-center gap-2 px-3 py-1 border-t border-surface-border">
        <button class="text-11-regular text-text-weak hover:text-text-base" onClick={() => setLines([])}>Clear</button>
        <button class="text-11-regular text-text-weak hover:text-text-base" onClick={() => copyOutput(filtered())}>Copy All</button>
        <span class="text-11-regular text-text-weak ml-auto">{filtered().length} lines</span>
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
}

async function copyOutput(lines: OutputLine[]) {
  await navigator.clipboard.writeText(lines.map(l => l.text).join("\n"))
}
