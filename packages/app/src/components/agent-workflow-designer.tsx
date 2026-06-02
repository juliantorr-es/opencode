import { For, createSignal, createMemo, Show } from "solid-js"
import { presets } from "opencode/agent/workflow/presets"
import { compileWorkflow, formatExecutionPlan } from "opencode/agent/workflow/engine"
import type { AgentWorkflow } from "opencode/agent/workflow/schema"

export function AgentWorkflowDesigner() {
  const [selectedPreset, setSelectedPreset] = createSignal(presets[0].id)
  const [goal, setGoal] = createSignal("")
  const [scope, setScope] = createSignal("")
  const [plan, setPlan] = createSignal("")

  const current = createMemo(() => presets.find(p => p.id === selectedPreset())!)

  function generate() {
    const workflow: AgentWorkflow = { ...current().template, scope: { directories: scope().split("\n").filter(Boolean) } }
    const result = compileWorkflow(workflow)
    setPlan(formatExecutionPlan(result))
  }

  return (
    <div class="flex flex-col h-full bg-surface-base">
      <div class="px-3 py-2 border-b border-surface-border">
        <span class="text-13-regular font-medium">Workflow Designer</span>
      </div>
      <div class="flex-1 overflow-auto p-3 space-y-4">
        {/* Goal */}
        <div>
          <label class="text-11-regular text-text-weak uppercase tracking-wider">Goal</label>
          <input type="text" value={goal()} onInput={(e) => setGoal(e.currentTarget.value)} placeholder="What are you trying to do?" class="w-full mt-1 bg-surface-raised text-12-regular px-2 py-1 rounded border border-surface-border" />
        </div>

        {/* Preset */}
        <div>
          <label class="text-11-regular text-text-weak uppercase tracking-wider">Workflow Style</label>
          <select value={selectedPreset()} onChange={(e) => setSelectedPreset(e.currentTarget.value)} class="w-full mt-1 bg-surface-raised text-12-regular px-2 py-1 rounded border border-surface-border">
            <For each={presets}>{(p) => <option value={p.id}>{p.name} — {p.description}</option>}</For>
          </select>
        </div>

        {/* Scope */}
        <div>
          <label class="text-11-regular text-text-weak uppercase tracking-wider">Scope (directories, one per line)</label>
          <textarea value={scope()} onInput={(e) => setScope(e.currentTarget.value)} rows={3} placeholder="packages/opencode/src/&#10;packages/desktop/src/" class="w-full mt-1 bg-surface-raised text-12-regular px-2 py-1 rounded border border-surface-border resize-none" />
        </div>

        {/* Generated Plan */}
        <button onClick={generate} class="w-full py-1.5 bg-accent text-accent-contrast text-12-regular rounded hover:bg-accent/90">Generate Plan</button>

        <Show when={plan()}>
          <div class="mt-3 p-3 bg-surface-raised rounded border border-surface-border">
            <pre class="text-11-regular leading-5 whitespace-pre-wrap font-mono">{plan()}</pre>
          </div>
        </Show>
      </div>
    </div>
  )
}
