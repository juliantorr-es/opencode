import { For, Show, createMemo } from "solid-js"
import { useProjectActivation } from "@/context/project-activation"

interface FileEntry {
  path: string
  name: string
  claimed: boolean
  claimAgent?: string
  modified: boolean
  dirty: boolean
  validationStatus?: "pass" | "fail" | "pending"
  lastEvent?: string
}

export function AgentExplorer() {
  const activation = useProjectActivation()

  // In production, these come from projections/code-index.
  // For now, show a structure that reads from the project directory.
  const files = createMemo<FileEntry[]>(() => {
    const dir = activation.currentDirectory()
    if (!dir) return []
    return [] // populated from code-index projection in production
  })

  return (
    <div class="flex flex-col h-full bg-surface-base">
      <div class="px-3 py-2 text-12-regular text-text-weak uppercase tracking-wider">
        Project Explorer
      </div>
      <div class="flex-1 overflow-auto">
        <Show when={files().length === 0}>
          <div class="px-3 py-6 text-center text-12-regular text-text-weak">
            <p>No files indexed yet.</p>
            <p class="mt-1">Open a project to build the file index.</p>
          </div>
        </Show>
        <For each={files()}>
          {(file) => (
            <div class="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover cursor-pointer text-13-regular">
              <span class="text-text-weak">{file.claimed ? "🔒" : file.modified ? "✎" : "📄"}</span>
              <span class="flex-1 truncate">{file.name}</span>
              {file.claimed && (
                <span class="text-11-regular text-accent px-1.5 py-0.5 rounded bg-accent/10" title={`Claimed by ${file.claimAgent}`}>
                  {file.claimAgent?.slice(0, 8)}
                </span>
              )}
              {file.dirty && <span class="w-1.5 h-1.5 rounded-full bg-warning" title="Modified" />}
              {file.validationStatus === "fail" && <span class="text-11-regular text-danger">!</span>}
            </div>
          )}
        </For>
      </div>
      <div class="px-3 py-1.5 border-t border-surface-border text-11-regular text-text-weak">
        {files().length} files · {files().filter(f => f.claimed).length} claimed
      </div>
    </div>
  )
}
