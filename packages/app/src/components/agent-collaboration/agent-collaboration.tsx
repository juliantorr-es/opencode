import { For, Show } from "solid-js"
import { useAgentCollaboration } from "../../context/agent-collaboration"
import { AgentColumn } from "./agent-column"
import "./agent-collaboration.css"

export function AgentCollaboration() {
  const { agents, isOpen, toggle } = useAgentCollaboration()
  const visibleAgents = agents

  return (
    <>
      {/* Toggle button */}
      <Show when={!isOpen()}>
        <button
          class="agent-panel-toggle"
          onClick={toggle}
          title="Open Agent Collaboration Panel"
          aria-label="Open agent collaboration"
        >
          <span class="agent-toggle-icon">🤖</span>
          <Show when={visibleAgents().length > 0}>
            <span class="agent-toggle-count">{visibleAgents().length}</span>
          </Show>
        </button>
      </Show>

      {/* Panel overlay */}
      <Show when={isOpen()}>
        <div class="agent-panel-backdrop" onClick={toggle} />
      </Show>

      {/* Panel */}
      <div
        class="agent-collaboration-panel"
        data-open={isOpen()}
        role="region"
        aria-label="Agent collaboration panel"
      >
        {/* Panel header */}
        <div class="agent-panel-topbar">
          <div class="agent-panel-title">
            <span>🤖 Agent Collaboration</span>
            <span class="agent-panel-count">{visibleAgents().length} active</span>
          </div>
          <div class="agent-panel-actions">
            <button
              class="agent-panel-close"
              onClick={toggle}
              title="Close panel"
              aria-label="Close agent collaboration"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Columns container */}
        <div class="agent-columns-container">
          <Show
            when={visibleAgents().length > 0}
            fallback={
              <div class="agent-empty-state">
                <span class="agent-empty-icon">🤖</span>
                <p class="agent-empty-text">No agents active</p>
                <p class="agent-empty-hint">
                  Agents will appear here when they start working
                </p>
              </div>
            }
          >
            <For each={visibleAgents()}>
              {(agent) => <AgentColumn agent={agent} />}
            </For>
          </Show>
        </div>
      </div>
    </>
  )
}

export { AgentColumn } from "./agent-column"
