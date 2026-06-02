import { For, Show, createSignal, createMemo } from "solid-js"
import { useProjectActivation } from "@/context/project-activation"

interface GitFileEntry {
  path: string
  status: "modified" | "added" | "deleted" | "untracked"
  staged: boolean
  agentTouched: boolean
  claimAgent?: string
}

export function AgentGitPanel() {
  const activation = useProjectActivation()
  const [branch, setBranch] = createSignal<string>("unknown")
  const [dirtyCount, setDirtyCount] = createSignal(0)

  const files = createMemo<GitFileEntry[]>(() => [])

  const ready = createMemo(() => dirtyCount() === 0 && files().every(f => !f.agentTouched || f.staged))

  return (
    <div class="flex flex-col h-full bg-surface-base">
      <div class="flex items-center justify-between px-3 py-2 border-b border-surface-border">
        <div class="flex items-center gap-2">
          <span class="text-13-regular">{branch()}</span>
          <span class={`w-2 h-2 rounded-full ${ready() ? "bg-success" : "bg-warning"}`} />
        </div>
        <span class="text-11-regular text-text-weak">{dirtyCount()} files changed</span>
      </div>
      <div class="flex-1 overflow-auto">
        <Show when={files().length === 0}>
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">
            <p>No changes detected.</p>
            <p class="mt-1">{ready() ? "Working tree clean." : "Open a project to check git status."}</p>
          </div>
        </Show>
        <For each={files()}>
          {(file) => (
            <div class="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover cursor-pointer text-12-regular">
              <span class={`w-2 h-2 rounded-full flex-shrink-0 ${
                file.status === "modified" ? "bg-warning" : file.status === "added" ? "bg-success" : file.status === "deleted" ? "bg-danger" : "bg-text-weak"
              }`} />
              <span class="flex-1 truncate">{file.path}</span>
              {file.agentTouched && (
                <span class="text-11-regular text-accent px-1 py-0.5 rounded bg-accent/10">
                  {file.claimAgent?.slice(0, 8) ?? "agent"}
                </span>
              )}
              <span class="text-11-regular text-text-weak">{file.status}</span>
            </div>
          )}
        </For>
      </div>
      <div class="px-3 py-2 border-t border-surface-border">
        <Show when={!ready()}>
          <div class="text-11-regular text-warning mb-1">
            {dirtyCount() > 0 ? `${dirtyCount()} uncommitted change(s)` : ""}
            {files().some(f => f.agentTouched && !f.staged) ? " · Agent changes pending" : ""}
          </div>
        </Show>
        <div class="flex gap-2">
          <button class="text-11-regular text-text-weak hover:text-text-base">Stage All</button>
          <button class="text-11-regular text-text-weak hover:text-text-base">Commit</button>
          <button class="text-11-regular text-text-weak hover:text-text-base" onClick={() => copyGitStatus()}>Copy Status</button>
        </div>
      </div>
    </div>
  )
}

async function copyGitStatus() {
  await navigator.clipboard.writeText("git status output placeholder")
}
