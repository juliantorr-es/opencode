import { Match, Switch, Show } from "solid-js"
import { type Artifact } from "@/context/artifact"
import { Spinner } from "@opencode-ai/ui/spinner"

import { Tag } from "@opencode-ai/ui/tag"
import {
  formatArtifactRuntimeKind,
  formatWorkspaceMode,
  formatWorkspaceTruth,
} from "@/utils/cockpit-truth"

import { CommandArtifactViewer } from "./command-artifact-viewer"

export interface ArtifactViewerProps {
  artifact: Artifact
}

export function ArtifactViewer(props: ArtifactViewerProps) {
  return (
    <div class="flex flex-col w-full h-full bg-background-overlay rounded-md border border-border-default overflow-hidden">
      <div class="flex flex-col px-3 py-2 border-b border-border-default bg-background-panel gap-1.5 shrink-0">
        <div class="flex items-center justify-between">
          <span class="text-12-medium text-text-primary">{props.artifact.title}</span>
          <span class="text-11-regular text-text-tertiary uppercase">{props.artifact.type}</span>
        </div>
        
        <div class="flex flex-wrap items-center gap-1.5">
          <Show when={props.artifact.producer}>
            <Tag class="text-10-regular bg-background-base text-text-secondary border border-border-default px-1.5 py-0.5 min-w-0">
              {props.artifact.producer}
            </Tag>
          </Show>
          <Show when={props.artifact.runtime}>
            <Tag class="text-10-regular bg-background-base text-text-secondary border border-border-default px-1.5 py-0.5 min-w-0">
              {formatArtifactRuntimeKind(props.artifact.runtime)}
            </Tag>
          </Show>
          <Show when={props.artifact.workspaceMode}>
            <Tag class="text-10-regular bg-background-base text-text-secondary border border-border-default px-1.5 py-0.5 min-w-0">
              {formatWorkspaceMode(props.artifact.workspaceMode)}
            </Tag>
          </Show>
          <Show when={props.artifact.affectsRealWorkspace !== undefined}>
            <Tag 
              class={`text-10-regular px-1.5 py-0.5 border min-w-0 ${
                props.artifact.affectsRealWorkspace 
                  ? "bg-icon-warning-base/10 text-icon-warning-base border-icon-warning-base/20" 
                  : "bg-background-base text-text-tertiary border-border-default"
              }`}
            >
              {formatWorkspaceTruth(props.artifact.affectsRealWorkspace)}
            </Tag>
          </Show>
        </div>
      </div>

      <div class="flex-1 overflow-auto p-3">
        <Switch fallback={<div class="text-12-regular text-text-tertiary">Unsupported artifact type.</div>}>
          <Match when={props.artifact.status === "generating"}>
            <div class="flex items-center justify-center h-full text-text-secondary gap-2">
              <Spinner class="w-4 h-4" />
              <span class="text-12-regular">Generating artifact...</span>
            </div>
          </Match>
          <Match when={props.artifact.status === "error" || props.artifact.status === "unavailable"}>
            <div class="flex flex-col items-center justify-center h-full text-text-secondary gap-2 text-center">
              <span class="text-13-medium text-text-primary">
                {props.artifact.status === "error" ? "Artifact Error" : "Artifact Unavailable"}
              </span>
              <span class="text-12-regular text-text-tertiary">
                {props.artifact.reason || "This artifact could not be loaded."}
              </span>
            </div>
          </Match>
          <Match when={props.artifact.status === "available"}>
            <Switch>
              <Match when={props.artifact.type === "text"}>
                <pre class="text-12-regular whitespace-pre-wrap break-words">{props.artifact.content}</pre>
              </Match>
              <Match when={props.artifact.type === "json"}>
                <pre class="text-12-regular whitespace-pre-wrap break-words font-mono text-xs">{props.artifact.content}</pre>
              </Match>
              <Match when={props.artifact.type === "markdown"}>
                {/* For Phase B0, we will just render markdown as text/pre to keep it simple, since Markdown viewer requires marked context which we have but might be complex to wire instantly */}
                <div class="prose prose-sm dark:prose-invert max-w-none text-12-regular">
                  <pre class="whitespace-pre-wrap">{props.artifact.content}</pre>
                </div>
              </Match>
              <Match when={props.artifact.type === "command_result"}>
                <CommandArtifactViewer artifact={props.artifact} />
              </Match>
              <Match when={true}>
                <div class="text-12-regular text-text-tertiary">Preview not implemented for {props.artifact.type}.</div>
              </Match>
            </Switch>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
