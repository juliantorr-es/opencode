import { For, Show, createSignal } from "solid-js"
import { useArtifacts, type Artifact } from "@/context/artifact"
import { applyArtifactEventV0 } from "@/context/artifact-event"
import { commandResultToArtifactEventsV0 } from "@/context/artifact-command-source"
import { ArtifactViewer } from "@/components/artifacts/artifact-viewer"
import { Button } from "@opencode-ai/ui/button"

export interface ArtifactRailProps {
  sessionID: string
}

export function ArtifactRail(props: ArtifactRailProps) {
  const artifactsCtx = useArtifacts()

  // Dev-only manual injection
  const injectSampleArtifact = () => {
    applyArtifactEventV0({
      schema: "tribunus.artifact_event.v0",
      eventID: `dev_sample_event_${Date.now()}`,
      kind: "artifact.created",
      sessionID: props.sessionID,
      artifactID: `dev_sample_${Date.now()}`,
      timestamp: Date.now(),
      type: "text",
      title: "Sample Dev Artifact",
      inlineContent: "This is a dev-only sample artifact content injected for verification.",
      producer: "dev",
      workspaceMode: "virtual_fs_sandbox",
    }, artifactsCtx)
  }

  const injectCommandResult = () => {
    const events = commandResultToArtifactEventsV0({
      schema: "tribunus.command_result_source.v0",
      commandID: `cmd_${Date.now()}`,
      sessionID: props.sessionID,
      command: "[DEV SAMPLE] bun test",
      cwd: "/Users/dev/sample-project",
      exitCode: 1,
      startedAt: Date.now() - 5000,
      completedAt: Date.now(),
      stderr: "[DEV SAMPLE] 1 test failed: packages/app/src/context/sample.test.ts",
      runtime: "native-pty",
      workspaceMode: "local",
      affectsRealWorkspace: false
    })
    
    events.forEach(event => applyArtifactEventV0(event, artifactsCtx))
  }

  const artifacts = () => artifactsCtx.getArtifactsBySession(props.sessionID)

  return (
    <div class="flex flex-col w-[350px] h-full bg-background-base border-l border-border-default overflow-hidden">
      <div class="flex items-center justify-between px-4 py-3 border-b border-border-default shrink-0">
        <h3 class="text-13-medium text-text-primary">Artifacts</h3>
        {/* Dev only injection path */}
        <Show when={import.meta.env.DEV}>
          <div class="rounded-md border border-dashed border-amber-500/60 bg-amber-500/5 px-2 py-1">
            <div class="text-10-medium uppercase tracking-wider text-amber-700 mb-1">DEV INJECTION</div>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="small" onClick={injectSampleArtifact}>
                + Sample
              </Button>
              <Button variant="ghost" size="small" onClick={injectCommandResult}>
                + Command
              </Button>
            </div>
          </div>
        </Show>
      </div>

      <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        <Show 
          when={artifacts().length > 0} 
          fallback={
            <div class="flex flex-col items-center justify-center h-full text-center p-4 rounded-lg border border-dashed border-border-default bg-background-overlay">
              <span class="text-13-medium text-text-primary mb-1">No evidence yet</span>
              <span class="text-12-regular text-text-tertiary max-w-[220px]">
                Outputs from executed commands and workspace changes will appear here as artifacts are produced.
              </span>
            </div>
          }
        >
          <For each={artifacts()}>
            {(artifact) => (
              <div class="h-[300px]">
                <ArtifactViewer artifact={artifact} />
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
