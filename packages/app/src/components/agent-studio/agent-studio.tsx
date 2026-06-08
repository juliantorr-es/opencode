import { Button } from "@tribunus/ui/button"
import { Icon } from "@tribunus/ui/icon"
import { ResizeHandle } from "@tribunus/ui/resize-handle"
import type { Component } from "solid-js"
import { createMemo, createSignal, Show } from "solid-js"
import { AgentEditor } from "./agent-editor"
import { AgentList } from "./agent-list"
import { AgentPreview } from "./agent-preview"
import type { AgentStudioConfig } from "./types"
import { DEFAULT_BUILTIN_AGENTS } from "./types"
import "./agent-studio.css"

export const AgentStudio: Component = () => {
  const [agents, setAgents] = createSignal<AgentStudioConfig[]>(DEFAULT_BUILTIN_AGENTS)
  const [activeId, setActiveId] = createSignal(DEFAULT_BUILTIN_AGENTS[0]?.id ?? "")
  const [sidebarWidth, setSidebarWidth] = createSignal(260)
  const [previewWidth, setPreviewWidth] = createSignal(340)
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)

  const activeAgent = createMemo(() => agents().find((a) => a.id === activeId()))

  const nextId = () => `agent_${crypto.randomUUID().slice(0, 8)}`

  const handleChange = (updated: AgentStudioConfig) => {
    setAgents(agents().map((a) => (a.id === updated.id ? updated : a)))
  }

  const handleCreate = () => {
    const newAgent: AgentStudioConfig = {
      id: nextId(),
      name: "New Agent",
      role: "custom",
      systemPrompt: "You are a helpful assistant.",
      model: "gpt-4o-mini",
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 4096,
      enabledTools: ["read_source", "smart_grep", "smart_find"],
      color: "#6b7280",
      isBuiltin: false,
      isActive: true,
    }
    setAgents([...agents(), newAgent])
    setActiveId(newAgent.id)
  }

  const handleDuplicate = (id: string) => {
    const source = agents().find((a) => a.id === id)
    if (!source) return
    const dup: AgentStudioConfig = {
      ...source,
      id: nextId(),
      name: `${source.name} (copy)`,
      isBuiltin: false,
    }
    setAgents([...agents(), dup])
    setActiveId(dup.id)
  }

  const handleDelete = (id: string) => {
    setConfirmDelete(id)
  }

  const handleConfirmDelete = () => {
    const id = confirmDelete()
    if (!id) return
    setAgents(agents().filter((a) => a.id !== id))
    if (activeId() === id) {
      const remaining = agents().filter((a) => a.id !== id)
      setActiveId(remaining[0]?.id ?? "")
    }
    setConfirmDelete(null)
  }

  const handleCancelDelete = () => {
    setConfirmDelete(null)
  }

  return (
    <div data-component="agent-studio">
      {/* Top bar */}
      <div data-slot="studio-topbar">
        <div data-slot="studio-topbar-left">
          <Icon name="brain" size="medium" />
          <span data-slot="studio-title">Agent Studio</span>
        </div>
        <div data-slot="studio-topbar-right">
          <Button variant="ghost" size="small" icon="reset" onClick={() => setAgents(DEFAULT_BUILTIN_AGENTS)}>
            Reset
          </Button>
          <Button variant="primary" size="small" icon="check-small">
            Save Changes
          </Button>
        </div>
      </div>

      {/* Main layout */}
      <div data-slot="studio-body">
        {/* Left sidebar */}
        <div data-slot="studio-sidebar" style={{ width: `${sidebarWidth()}px` }}>
          <AgentList
            agents={agents()}
            activeId={activeId()}
            onSelect={setActiveId}
            onCreate={handleCreate}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
          />
        </div>

        <ResizeHandle
          direction="horizontal"
          edge="end"
          size={sidebarWidth()}
          min={200}
          max={400}
          onResize={setSidebarWidth}
        />

        {/* Center editor */}
        <div data-slot="studio-editor">
          <Show when={activeAgent()} fallback={
            <div data-slot="studio-empty">
              <Icon name="brain" size="large" />
              <span>Select an agent to edit</span>
            </div>
          }>
            {(a) => (
              <AgentEditor
                agent={a()}
                onChange={handleChange}
              />
            )}
          </Show>
        </div>

        <ResizeHandle
          direction="horizontal"
          edge="start"
          size={previewWidth()}
          min={280}
          max={500}
          onResize={setPreviewWidth}
        />

        {/* Right preview */}
        <div data-slot="studio-preview" style={{ width: `${previewWidth()}px` }}>
          <Show when={activeAgent()}>
            {(a) => <AgentPreview agent={a()} />}
          </Show>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Show when={confirmDelete()}>
        <div data-slot="studio-overlay" onClick={handleCancelDelete}>
          <div data-slot="studio-dialog" onClick={(e: MouseEvent) => e.stopPropagation()}>
            <div data-slot="studio-dialog-header">
              <span data-slot="studio-dialog-title">Delete Agent</span>
            </div>
            <p data-slot="studio-dialog-text">
              Are you sure you want to delete this agent? This action cannot be undone.
            </p>
            <div data-slot="studio-dialog-actions">
              <Button variant="ghost" size="small" onClick={handleCancelDelete}>
                Cancel
              </Button>
              <Button variant="primary" size="small" onClick={handleConfirmDelete}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
