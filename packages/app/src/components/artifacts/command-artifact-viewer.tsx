import { Show } from "solid-js"
import type { Artifact } from "@/context/artifact"
import { Tag } from "@opencode-ai/ui/tag"

export interface CommandArtifactViewerProps {
  artifact: Artifact
}

export function CommandArtifactViewer(props: CommandArtifactViewerProps) {
  const metadata = () => props.artifact.commandMetadata

  return (
    <Show 
      when={metadata()} 
      fallback={<pre class="text-12-regular whitespace-pre-wrap break-words p-3">{props.artifact.content}</pre>}
    >
      <div class="flex flex-col text-12-regular text-text-secondary h-full p-3 gap-4 overflow-y-auto">
        <div class="flex flex-col rounded-lg border border-border-default overflow-hidden bg-background-overlay">
          <div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-border-default bg-background-panel">
            <div class="min-w-0">
              <div class="text-11-medium uppercase tracking-wider text-text-weaker">Command receipt</div>
              <div class="font-mono text-12-regular text-text-primary break-all">$ {metadata()!.command}</div>
            </div>
            <Show
              when={metadata()!.exitCode !== undefined}
              fallback={
                <Show when={metadata()!.signal}>
                  <Tag class="text-10-regular bg-icon-warning-base/10 text-icon-warning-base border border-icon-warning-base/20 px-1.5 py-0.5">
                    signal {metadata()!.signal}
                  </Tag>
                </Show>
              }
            >
              <Tag
                class={`text-10-regular px-1.5 py-0.5 border ${
                  metadata()!.exitCode === 0
                    ? "bg-icon-success-base/10 text-icon-success-base border-icon-success-base/20"
                    : "bg-icon-warning-base/10 text-icon-warning-base border-icon-warning-base/20"
                }`}
              >
                exit code {metadata()!.exitCode}
              </Tag>
            </Show>
          </div>
          <div class="grid gap-1.5 px-3 py-2 bg-background-base">
            <Show when={metadata()!.cwd}>
              <div class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2">
                <span class="text-text-tertiary font-medium w-16">cwd</span>
                <span class="font-mono text-11-regular break-all">{metadata()!.cwd}</span>
              </div>
            </Show>
            <Show when={metadata()!.completedAt}>
              <div class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2">
                <span class="text-text-tertiary font-medium w-16">duration</span>
                <span class="text-12-regular">{metadata()!.completedAt! - metadata()!.startedAt}ms</span>
              </div>
            </Show>
          </div>
        </div>

        <Show when={metadata()!.stdout}>
          <div class="flex flex-col gap-1.5">
            <span class="text-11-medium text-text-tertiary uppercase tracking-wider">Stdout</span>
            <div class="bg-background-base border border-border-default rounded-lg p-3 overflow-x-auto">
              <pre class="font-mono text-11-regular text-text-primary whitespace-pre-wrap break-words">{metadata()!.stdout}</pre>
            </div>
          </div>
        </Show>

        <Show when={metadata()!.stderr}>
          <div class="flex flex-col gap-1.5">
            <span class="text-11-medium text-text-tertiary uppercase tracking-wider">Stderr</span>
            <div class="bg-background-base border border-border-default rounded-lg p-3 overflow-x-auto">
              <pre class="font-mono text-11-regular text-icon-warning-base whitespace-pre-wrap break-words">{metadata()!.stderr}</pre>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}
