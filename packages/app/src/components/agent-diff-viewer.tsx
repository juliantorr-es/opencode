import { For, Show, createSignal } from "solid-js"

interface DiffHunk {
  header: string
  lines: { type: "add" | "remove" | "context"; content: string; oldLine?: number; newLine?: number }[]
}

export function AgentDiffViewer(props: {
  diffText?: string
  fileName?: string
  agentName?: string
}) {
  const [viewMode, setViewMode] = createSignal<"unified" | "split">("unified")

  const hunks = () => parseDiff(props.diffText ?? "")

  return (
    <div class="flex flex-col h-full bg-surface-base">
      <div class="flex items-center justify-between px-3 py-2 border-b border-surface-border">
        <div class="flex items-center gap-2">
          <span class="text-13-regular font-medium">{props.fileName ?? "Diff"}</span>
          {props.agentName && (
            <span class="text-11-regular text-accent px-1.5 py-0.5 rounded bg-accent/10">
              {props.agentName}
            </span>
          )}
        </div>
        <div class="flex gap-1">
          <button class={`px-2 py-0.5 text-11-regular rounded ${viewMode() === "unified" ? "bg-accent/20 text-accent" : "text-text-weak"}`} onClick={() => setViewMode("unified")}>Unified</button>
          <button class={`px-2 py-0.5 text-11-regular rounded ${viewMode() === "split" ? "bg-accent/20 text-accent" : "text-text-weak"}`} onClick={() => setViewMode("split")}>Split</button>
        </div>
      </div>
      <div class="flex-1 overflow-auto font-mono text-12-regular leading-5">
        <Show when={!props.diffText}>
          <div class="px-3 py-6 text-center text-text-weak">Select a file to view its diff</div>
        </Show>
        <For each={hunks()}>
          {(hunk) => (
            <div>
              <div class="px-3 py-0.5 text-11-regular text-text-weak bg-surface-raised">{hunk.header}</div>
              <For each={hunk.lines}>
                {(line) => (
                  <div class={`px-3 whitespace-pre ${line.type === "add" ? "bg-success/10 text-success" : line.type === "remove" ? "bg-danger/10 text-danger" : "text-text-base"}`}>
                    {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "} {line.content}
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <div class="px-3 py-1.5 border-t border-surface-border flex gap-2">
        <button class="text-11-regular text-text-weak hover:text-text-base" onClick={() => { if (props.diffText) navigator.clipboard.writeText(props.diffText) }}>Copy Patch</button>
        <button class="text-11-regular text-text-weak hover:text-text-base">Open Externally</button>
      </div>
    </div>
  )
}

function parseDiff(text: string): DiffHunk[] {
  if (!text) return []
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] }
      hunks.push(current)
    } else if (current) {
      current.lines.push({
        type: line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context",
        content: line,
      })
    }
  }
  return hunks
}

