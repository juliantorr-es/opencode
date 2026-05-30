import { For, Show, createSignal } from "solid-js"
import type { AgentState } from "../../context/agent-collaboration"
import { useAgentCollaboration } from "../../context/agent-collaboration"
import "./agent-collaboration.css"

interface AgentColumnProps {
  agent: AgentState
}

const STATUS_LABELS: Record<string, string> = {
  idle: "Idle",
  thinking: "Thinking...",
  working: "Working",
  blocked: "Blocked",
  done: "Done",
}

const ROLE_BADGES: Record<string, string> = {
  planner: "Planner",
  coder: "Coder",
  reviewer: "Reviewer",
  tester: "Tester",
  general: "General",
}

const ACTIVITY_ICONS: Record<string, string> = {
  tool_call: "🔧",
  file_edit: "📝",
  thinking: "💭",
  session_status: "●",
  message: "💬",
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 1000) return "now"
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  return `${Math.floor(diff / 3600000)}h ago`
}

function statusDotClass(status: string): string {
  return `agent-status-dot agent-status-${status}`
}

function statusDotTitle(status: string): string {
  return STATUS_LABELS[status] ?? status
}

export function AgentColumn(props: AgentColumnProps) {
  const { setAgentTool, addEditedFile } = useAgentCollaboration()
  const [toolExpanded, setToolExpanded] = createSignal(false)
  const [filesExpanded, setFilesExpanded] = createSignal(true)
  const agent = () => props.agent

  return (
    <div class="agent-column" data-agent-role={agent().role}>
      {/* Header */}
      <div class="agent-column-header">
        <div class="agent-header-top">
          <span class={statusDotClass(agent().status)} title={statusDotTitle(agent().status)} />
          <span class="agent-name">{agent().name}</span>
          <span
            class="agent-role-badge"
            style={{ "background-color": `${agent().color}20`, color: agent().color }}
          >
            {ROLE_BADGES[agent().role] ?? agent().role}
          </span>
        </div>
        <div class="agent-header-status">
          <span class="agent-status-text" data-status={agent().status}>
            {STATUS_LABELS[agent().status] ?? agent().status}
          </span>
          <Show when={agent().status === "thinking" || agent().status === "working"}>
            <span class="thinking-dots">
              <span class="thinking-dot" />
              <span class="thinking-dot" />
              <span class="thinking-dot" />
            </span>
          </Show>
        </div>
      </div>

      {/* Thinking section */}
      <Show when={agent().currentThinking && (agent().status === "thinking" || agent().status === "working")}>
        <div class="agent-thinking-section">
          <div class="agent-section-label">
            <span>💭 Thinking</span>
          </div>
          <div class="agent-thinking-content">
            {agent().currentThinking!.split("\n").map((line, i) => (
              <span class="agent-thinking-line" style={{ "animation-delay": `${i * 0.05}s` }}>
                {line}
              </span>
            ))}
          </div>
        </div>
      </Show>

      {/* Tool section */}
      <Show when={agent().currentTool}>
        <div class="agent-tool-section">
          <button
            class="agent-section-label agent-tool-toggle"
            onClick={() => setToolExpanded((prev) => !prev)}
          >
            <span>🔧 {agent().currentTool}</span>
            <span class="agent-chevron" data-expanded={toolExpanded()}>
              ▼
            </span>
          </button>
          <Show when={toolExpanded() && agent().currentToolResult}>
            <div class="agent-tool-result">{agent().currentToolResult}</div>
          </Show>
        </div>
      </Show>

      {/* Files section */}
      <Show when={agent().editedFiles.length > 0}>
        <div class="agent-files-section">
          <button
            class="agent-section-label agent-files-toggle"
            onClick={() => setFilesExpanded((prev) => !prev)}
          >
            <span>📄 Files ({agent().editedFiles.length})</span>
            <span class="agent-chevron" data-expanded={filesExpanded()}>
              ▼
            </span>
          </button>
          <Show when={filesExpanded()}>
            <div class="agent-files-list">
              <For each={agent().editedFiles}>
                {(file) => (
                  <div class="agent-file-item">
                    <span class="agent-file-icon">📄</span>
                    <span class="agent-file-path">{file}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* Activity feed */}
      <Show when={agent().recentActivity.length > 0}>
        <div class="agent-activity-section">
          <div class="agent-section-label">
            <span>Activity</span>
          </div>
          <div class="agent-activity-list">
            <For each={agent().recentActivity}>
              {(entry) => (
                <div class="agent-activity-item">
                  <span class="agent-activity-icon">
                    {ACTIVITY_ICONS[entry.type] ?? "●"}
                  </span>
                  <span class="agent-activity-summary">{entry.summary}</span>
                  <span class="agent-activity-time">
                    {formatRelativeTime(entry.timestamp)}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
