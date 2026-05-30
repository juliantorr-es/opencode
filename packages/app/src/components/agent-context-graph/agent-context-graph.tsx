import { Show } from "solid-js"
import { useAgentContext } from "@/context/agent-context"
import { ContextGraph } from "./context-graph"
import { ContextLegend } from "./context-legend"
import "./context-graph.css"

export function AgentContextGraph() {
  const { isOpen, toggle } = useAgentContext()

  return (
    <Show when={isOpen()}>
      <div class="agent-context-backdrop" onClick={toggle} />
      <div class="agent-context-panel" data-open={isOpen()}>
        <div class="agent-context-topbar">
          <div class="agent-context-title">
            <span>Agent Context</span>
            <span class="agent-context-count">N files</span>
          </div>
          <div class="agent-context-actions">
            <button
              type="button"
              class="agent-context-close"
              onClick={toggle}
              aria-label="Close context graph"
            >
              ✕
            </button>
          </div>
        </div>
        <div class="agent-context-body">
          <ContextGraph />
        </div>
        <div class="agent-context-legend-area">
          <ContextLegend />
        </div>
      </div>
    </Show>
  )
}
