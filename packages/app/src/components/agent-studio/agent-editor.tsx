import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { Select } from "@opencode-ai/ui/select"
import { For, type ComponentProps, splitProps } from "solid-js"
import type { AgentStudioConfig } from "./types"
import { AVAILABLE_MODELS, AVAILABLE_TOOLS, ROLE_COLORS } from "./types"

export interface AgentEditorProps {
  agent: AgentStudioConfig
  onChange: (config: AgentStudioConfig) => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

type RoleOption = { label: string; value: string }
const ROLE_OPTIONS: RoleOption[] = [
  { label: "Planner", value: "planner" },
  { label: "Coder", value: "coder" },
  { label: "Reviewer", value: "reviewer" },
  { label: "Tester", value: "tester" },
  { label: "Custom", value: "custom" },
]
const MODEL_OPTIONS = AVAILABLE_MODELS.map((m) => ({ label: m, value: m }))
const MAX_TOOLS_GRID = 3

export function AgentEditor(raw: AgentEditorProps) {
  const [props, rest] = splitProps(raw, ["agent", "onChange", "class", "classList"])

  const currentRole = () => ROLE_OPTIONS.find((r) => r.value === props.agent.role)
  const currentModel = () => MODEL_OPTIONS.find((m) => m.value === props.agent.model)

  const update = (patch: Partial<AgentStudioConfig>) => {
    props.onChange({ ...props.agent, ...patch })
  }

  return (
    <div
      {...rest}
      data-component="agent-studio-editor"
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
    >
      {/* Name + Role row */}
      <div data-slot="editor-row">
        <div data-slot="editor-field" data-grow>
          <label data-slot="editor-label">Name</label>
          <TextField
            type="text"
            value={props.agent.name}
            onChange={(v: string) => update({ name: v })}
            placeholder="Agent name"
          />
        </div>
        <div data-slot="editor-field">
          <label data-slot="editor-label">Role</label>
          <Select<RoleOption>
            options={ROLE_OPTIONS}
            current={currentRole()}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(o) => {
              if (o) update({ role: o.value as AgentStudioConfig["role"] })
            }}
            placeholder="Select role"
            triggerVariant="settings"
          />
        </div>
      </div>

      {/* Model + Temperature row */}
      <div data-slot="editor-row">
        <div data-slot="editor-field" data-grow>
          <label data-slot="editor-label">Model</label>
          <Select<{ label: string; value: string }>
            options={MODEL_OPTIONS}
            current={currentModel()}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(o) => {
              if (o) update({ model: o.value })
            }}
            placeholder="Select model"
            triggerVariant="settings"
          />
        </div>
        <div data-slot="editor-field">
          <label data-slot="editor-label">Temperature: {props.agent.temperature.toFixed(1)}</label>
          <RangeSlider
            value={props.agent.temperature}
            min={0}
            max={2}
            step={0.1}
            onChange={(v) => update({ temperature: v })}
          />
        </div>
      </div>

      {/* Top P + Max Tokens row */}
      <div data-slot="editor-row">
        <div data-slot="editor-field">
          <label data-slot="editor-label">Top P: {props.agent.topP.toFixed(2)}</label>
          <RangeSlider
            value={props.agent.topP}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => update({ topP: v })}
          />
        </div>
        <div data-slot="editor-field">
          <label data-slot="editor-label">Max Tokens</label>
          <TextField
            type="number"
            value={String(props.agent.maxTokens)}
            onChange={(v: string) => {
              const n = Number.parseInt(v, 10)
              if (!Number.isNaN(n) && n > 0) update({ maxTokens: n })
            }}
            min={256}
            max={128000}
            step={256}
          />
        </div>
      </div>

      {/* Color picker */}
      <div data-slot="editor-section">
        <label data-slot="editor-label">Color</label>
        <div data-slot="color-picker">
          <For each={["#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e", "#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6", "#6b7280"]}>
            {(c) => (
              <button
                type="button"
                data-slot="color-swatch"
                data-selected={props.agent.color === c || undefined}
                style={{ "background-color": c }}
                onClick={() => update({ color: props.agent.color === c ? "" : c })}
                aria-label={c}
              />
            )}
          </For>
        </div>
      </div>

      {/* System Prompt */}
      <div data-slot="editor-section">
        <label data-slot="editor-label">System Prompt</label>
        <textarea
          data-slot="editor-textarea"
          value={props.agent.systemPrompt}
          onChange={(e: Event) => {
            const target = e.currentTarget as HTMLTextAreaElement
            update({ systemPrompt: target.value })
          }}
          placeholder="You are a helpful assistant..."
          spellcheck={false}
        />
      </div>

      {/* Enabled Tools */}
      <div data-slot="editor-section">
        <label data-slot="editor-label">Enabled Tools</label>
        <div data-slot="tools-grid">
          <For each={AVAILABLE_TOOLS}>
            {(tool) => {
              const enabled = () => props.agent.enabledTools.includes(tool.id)
              return (
                <div data-slot="tool-card" data-enabled={enabled() || undefined}>
                  <div data-slot="tool-card-info">
                    <span data-slot="tool-card-name">{tool.name}</span>
                    <span data-slot="tool-card-desc">{tool.description}</span>
                  </div>
                  <Switch
                    checked={enabled()}
                    onChange={(v: boolean) => {
                      if (v) {
                        update({ enabledTools: [...props.agent.enabledTools, tool.id] })
                      } else {
                        update({ enabledTools: props.agent.enabledTools.filter((id) => id !== tool.id) })
                      }
                    }}
                  />
                </div>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}

// Inline range slider since @opencode-ai/ui/slider-v2 doesn't exist yet
function RangeSlider(p: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  const pct = () => ((p.value - p.min) / (p.max - p.min)) * 100
  return (
    <div data-slot="range-slider">
      <input
        type="range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={p.value}
        onInput={(e: Event) => {
          const target = e.currentTarget as HTMLInputElement
          p.onChange(Number.parseFloat(target.value))
        }}
        style={{
          "--range-pct": `${pct()}%`,
        } as Record<string, string>}
      />
    </div>
  )
}
