import { For, createSignal, createMemo, Show } from "solid-js"

// Inline workflow types — resolves without opencode package import.
// When opencode is available as a runtime dependency, these can be replaced
// with the canonical types from packages/opencode/src/agent/workflow/.

interface WorkflowRole {
  id: string
  agentProfile: string
  purpose: string
  canMutate: boolean
  allowedTools: string[]
  requiredInputs: string[]
  expectedOutputs: string[]
  dependsOn?: string[]
}

interface WorkflowGate {
  id: string
  kind: string
  required: boolean
  appliesAfter: string[]
}

interface WorkflowBudget {
  maxTimeMs?: number
  maxToolCalls?: number
  maxParallelLanes?: number
  stopOnFirstFailure?: boolean
}

interface ToolPolicy {
  allow: string[]
  deny: string[]
  requireApproval: string[]
}

interface WorkflowOutput {
  kind: string
  required: boolean
}

interface AgentWorkflow {
  id: string
  name: string
  description: string
  mode: string
  rigorLevel: string
  riskLevel: string
  roles: WorkflowRole[]
  gates: WorkflowGate[]
  budgets: WorkflowBudget
  tools: ToolPolicy
  outputs: WorkflowOutput[]
  scope?: {
    files?: string[]
    directories?: string[]
  }
}

interface WorkflowPreset {
  id: string
  name: string
  description: string
  mode: string
  rigorLevel: string
  defaultRisk: string
  template: AgentWorkflow
}

// Inline presets — mirrors packages/opencode/src/agent/workflow/presets.ts
const presets: WorkflowPreset[] = [
  {
    id: "quick-fix",
    name: "Quick Fix",
    description: "Small bug fixes. One scout, one fixer, targeted test.",
    mode: "quick_fix", rigorLevel: "fast", defaultRisk: "low",
    template: {
      id: "quick-fix", name: "Quick Fix", description: "Small bug fix",
      mode: "quick_fix", rigorLevel: "fast", riskLevel: "low",
      roles: [],
      gates: [],
      budgets: {},
      tools: { allow: [], deny: [], requireApproval: [] },
      outputs: [],
    },
  },
  {
    id: "prototype",
    name: "Prototype",
    description: "Fast exploration. One builder, one critic.",
    mode: "prototype", rigorLevel: "fast", defaultRisk: "low",
    template: {
      id: "prototype", name: "Prototype", description: "Build a quick prototype",
      mode: "prototype", rigorLevel: "fast", riskLevel: "low",
      roles: [], gates: [], budgets: {},
      tools: { allow: [], deny: [], requireApproval: [] },
      outputs: [],
    },
  },
  {
    id: "frontend-polish",
    name: "Frontend Polish",
    description: "UI/UX work with visual smoke test.",
    mode: "polish", rigorLevel: "balanced", defaultRisk: "low",
    template: {
      id: "frontend-polish", name: "Frontend Polish", description: "Polish the UI",
      mode: "polish", rigorLevel: "balanced", riskLevel: "low",
      roles: [], gates: [], budgets: {},
      tools: { allow: [], deny: [], requireApproval: [] },
      outputs: [],
    },
  },
  {
    id: "backend-hardening",
    name: "Backend Hardening",
    description: "Architecture-level changes with service boundary checks.",
    mode: "refactor", rigorLevel: "rigorous", defaultRisk: "medium",
    template: {
      id: "backend-hardening", name: "Backend Hardening", description: "Harden the backend",
      mode: "refactor", rigorLevel: "rigorous", riskLevel: "medium",
      roles: [], gates: [], budgets: {},
      tools: { allow: [], deny: [], requireApproval: [] },
      outputs: [],
    },
  },
  {
    id: "research",
    name: "Research / Spike",
    description: "Exploration with no production code changes.",
    mode: "research", rigorLevel: "fast", defaultRisk: "low",
    template: {
      id: "research", name: "Research", description: "Explore a topic",
      mode: "research", rigorLevel: "fast", riskLevel: "low",
      roles: [], gates: [], budgets: {},
      tools: { allow: [], deny: [], requireApproval: [] },
      outputs: [],
    },
  },
  {
    id: "security-review",
    name: "Security Review",
    description: "Adversarial security audit with red team.",
    mode: "security_review", rigorLevel: "rigorous", defaultRisk: "high",
    template: {
      id: "security-review", name: "Security Review", description: "Audit security",
      mode: "security_review", rigorLevel: "rigorous", riskLevel: "high",
      roles: [], gates: [], budgets: {},
      tools: { allow: [], deny: [], requireApproval: [] },
      outputs: [],
    },
  },
  {
    id: "enterprise-closure",
    name: "Enterprise Closure",
    description: "Full governed release pipeline.",
    mode: "enterprise", rigorLevel: "enterprise", defaultRisk: "medium",
    template: {
      id: "enterprise-closure", name: "Enterprise Closure", description: "Full release pipeline",
      mode: "enterprise", rigorLevel: "enterprise", riskLevel: "medium",
      roles: [], gates: [], budgets: {},
      tools: { allow: [], deny: [], requireApproval: [] },
      outputs: [],
    },
  },
  {
    id: "refactor",
    name: "Refactor",
    description: "Restructure code with safety nets.",
    mode: "refactor", rigorLevel: "balanced", defaultRisk: "medium",
    template: {
      id: "refactor", name: "Refactor", description: "Restructure code",
      mode: "refactor", rigorLevel: "balanced", riskLevel: "medium",
      roles: [], gates: [], budgets: {},
      tools: { allow: [], deny: [], requireApproval: [] },
      outputs: [],
    },
  },
]

export function AgentWorkflowDesigner() {
  const [selectedPreset, setSelectedPreset] = createSignal(presets[0].id)
  const [goal, setGoal] = createSignal("")
  const [scope, setScope] = createSignal("")
  const [plan, setPlan] = createSignal("")

  const current = createMemo(() => presets.find(p => p.id === selectedPreset()) ?? presets[0])

  function generate() {
    const workflow = current().template
    const dirs = scope().split("\n").filter(Boolean)
    const summary = [
      `# ${workflow.name}`,
      `Goal: ${goal() || "(none)"}`,
      `Mode: ${workflow.mode} | Rigor: ${workflow.rigorLevel} | Risk: ${workflow.riskLevel}`,
      `Scope: ${dirs.length ? dirs.join(", ") : "(none)"}`,
      "",
      `## Plan`,
      `Preset: ${current().name} — ${current().description}`,
      "",
      `(Workflow execution engine requires opencode runtime — generated plan will be available when the runtime is connected.)`,
    ].join("\n")
    setPlan(summary)
  }

  return (
    <div class="flex flex-col h-full bg-surface-base">
      <div class="px-3 py-2 border-b border-surface-border">
        <span class="text-13-regular font-medium">Workflow Designer</span>
      </div>
      <div class="flex-1 overflow-auto p-3 space-y-4">
        <div>
          <label class="text-11-regular text-text-weak uppercase tracking-wider">Goal</label>
          <input type="text" value={goal()} onInput={(e) => setGoal(e.currentTarget.value)} placeholder="What are you trying to do?" class="w-full mt-1 bg-surface-raised text-12-regular px-2 py-1 rounded border border-surface-border" />
        </div>

        <div>
          <label class="text-11-regular text-text-weak uppercase tracking-wider">Workflow Style</label>
          <select value={selectedPreset()} onChange={(e) => setSelectedPreset(e.currentTarget.value)} class="w-full mt-1 bg-surface-raised text-12-regular px-2 py-1 rounded border border-surface-border">
            <For each={presets}>{(p) => <option value={p.id}>{p.name} — {p.description}</option>}</For>
          </select>
        </div>

        <div>
          <label class="text-11-regular text-text-weak uppercase tracking-wider">Scope (directories, one per line)</label>
          <textarea value={scope()} onInput={(e) => setScope(e.currentTarget.value)} rows={3} placeholder="packages/opencode/src/&#10;packages/desktop/src/" class="w-full mt-1 bg-surface-raised text-12-regular px-2 py-1 rounded border border-surface-border resize-none" />
        </div>

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
