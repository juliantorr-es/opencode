import { For, Show, createMemo, createSignal } from "solid-js"

interface Problem {
  id: string
  severity: "error" | "warning" | "info"
  source: "typecheck" | "test" | "migration" | "boot" | "agent" | "projection"
  message: string
  file?: string
  line?: number
  agentName?: string
  status: "active" | "resolved" | "ignored"
  lastSeen: number
}

export function AgentProblemsPanel() {
  const [filter, setFilter] = createSignal<Problem["severity"] | "all">("all")

  const problems = createMemo<Problem[]>(() => [
    // Populated from diagnostics endpoint + typecheck/test results in production
  ])

  const filtered = createMemo(() =>
    filter() === "all" ? problems() : problems().filter(p => p.severity === filter())
  )

  const counts = createMemo(() => ({
    error: problems().filter(p => p.severity === "error").length,
    warning: problems().filter(p => p.severity === "warning").length,
    info: problems().filter(p => p.severity === "info").length,
  }))

  return (
    <div class="flex flex-col h-full bg-surface-base">
      <div class="flex items-center gap-1 px-3 py-1.5 border-b border-surface-border">
        <button class={`px-2 py-0.5 text-11-regular rounded ${filter() === "all" ? "bg-surface-raised" : ""}`} onClick={() => setFilter("all")}>All ({problems().length})</button>
        <button class={`px-2 py-0.5 text-11-regular rounded ${filter() === "error" ? "bg-danger/20 text-danger" : ""}`} onClick={() => setFilter("error")}>
          <span class="w-1.5 h-1.5 rounded-full bg-danger inline-block mr-1" />
          {counts().error}
        </button>
        <button class={`px-2 py-0.5 text-11-regular rounded ${filter() === "warning" ? "bg-warning/20 text-warning" : ""}`} onClick={() => setFilter("warning")}>
          <span class="w-1.5 h-1.5 rounded-full bg-warning inline-block mr-1" />
          {counts().warning}
        </button>
      </div>
      <div class="flex-1 overflow-auto">
        <For each={filtered()}>
          {(problem) => (
            <div class="px-3 py-1.5 border-b border-surface-border/50 hover:bg-surface-hover cursor-pointer">
              <div class="flex items-start gap-2">
                <span class={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  problem.severity === "error" ? "bg-danger" : problem.severity === "warning" ? "bg-warning" : "bg-text-weak"
                }`} />
                <div class="flex-1 min-w-0">
                  <div class="text-12-regular truncate">{problem.message}</div>
                  <div class="flex gap-2 mt-0.5 text-11-regular text-text-weak">
                    {problem.file && <span>{problem.file}{problem.line ? `:${problem.line}` : ""}</span>}
                    <span>{problem.source}</span>
                    {problem.agentName && <span class="text-accent">{problem.agentName}</span>}
                  </div>
                </div>
              </div>
            </div>
          )}
        </For>
        <Show when={problems().length === 0}>
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">No problems detected</div>
        </Show>
      </div>
    </div>
  )
}
