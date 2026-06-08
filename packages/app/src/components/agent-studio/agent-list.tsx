import { Icon } from "@tribunus/ui/icon"
import { IconButton } from "@tribunus/ui/icon-button"
import { type ComponentProps, For, Show, splitProps } from "solid-js"
import type { AgentStudioConfig } from "./types"
import { ROLE_COLORS } from "./types"

export interface AgentListProps {
  agents: AgentStudioConfig[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

export function AgentList(raw: AgentListProps) {
  const [props, rest] = splitProps(raw, [
    "agents", "activeId", "onSelect", "onCreate",
    "onDuplicate", "onDelete", "class", "classList",
  ])

  return (
    <div
      {...rest}
      data-component="agent-studio-list"
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
    >
      <div data-slot="agent-list-header">
        <span data-slot="agent-list-title">Agents</span>
        <IconButton
          icon="plus-small"
          variant="ghost"
          size="small"
          onClick={props.onCreate}
          aria-label="Create agent"
        />
      </div>

      <div data-slot="agent-list-items">
        <For each={props.agents}>
          {(agent) => {
            const isActive = () => agent.id === props.activeId
            const roleColor = () => ROLE_COLORS[agent.role] ?? ROLE_COLORS.custom
            return (
              <div
                data-slot="agent-list-item"
                data-active={isActive() || undefined}
                onClick={() => props.onSelect(agent.id)}
              >
                <div
                  data-slot="agent-item-dot"
                  style={{ "background-color": roleColor() }}
                />
                <div data-slot="agent-item-info">
                  <span data-slot="agent-item-name">{agent.name}</span>
                  <div data-slot="agent-item-meta">
                    <span data-slot="agent-item-role">{agent.role}</span>
                    <Show when={agent.isBuiltin}>
                      <span data-slot="agent-item-badge">BUILT-IN</span>
                    </Show>
                  </div>
                </div>
                <Show when={!agent.isBuiltin}>
                  <div data-slot="agent-item-actions">
                    <IconButton
                      icon="copy"
                      variant="ghost"
                      size="small"
                      onClick={(e: MouseEvent) => {
                        e.stopPropagation()
                        props.onDuplicate(agent.id)
                      }}
                      aria-label="Duplicate agent"
                    />
                    <IconButton
                      icon="trash"
                      variant="ghost"
                      size="small"
                      onClick={(e: MouseEvent) => {
                        e.stopPropagation()
                        props.onDelete(agent.id)
                      }}
                      aria-label="Delete agent"
                    />
                  </div>
                </Show>
              </div>
            )
          }}
        </For>
      </div>

      <div data-slot="agent-list-footer">
        <span data-slot="agent-list-count">
          <Icon name="brain" size="small" />
          {props.agents.length} agents
        </span>
      </div>
    </div>
  )
}
