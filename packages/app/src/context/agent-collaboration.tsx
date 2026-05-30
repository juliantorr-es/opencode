import { createSignal, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"

export type AgentRole = "planner" | "coder" | "reviewer" | "tester" | "general"
export type AgentStatus = "idle" | "thinking" | "working" | "blocked" | "done"

export interface ActivityEntry {
  type: string
  summary: string
  timestamp: number
}

export interface AgentState {
  id: string
  name: string
  role: AgentRole
  status: AgentStatus
  color: string
  currentThinking?: string
  currentTool?: string
  currentToolResult?: string
  editedFiles: string[]
  recentActivity: ActivityEntry[]
}

export interface AgentCollaborationContextType {
  agents: () => AgentState[]
  activeAgent: () => AgentState | undefined
  setAgentStatus: (id: string, status: AgentStatus) => void
  setAgentThinking: (id: string, text: string) => void
  appendAgentThinking: (id: string, text: string) => void
  setAgentTool: (id: string, tool: string, result?: string) => void
  addEditedFile: (id: string, file: string) => void
  addActivity: (id: string, type: string, summary: string) => void
  removeAgent: (id: string) => void
  addAgent: (agent: AgentState) => void
  isOpen: () => boolean
  toggle: () => void
}

const ROLE_COLORS: Record<AgentRole, string> = {
  planner: "#8b5cf6",
  coder: "#3b82f6",
  reviewer: "#22c55e",
  tester: "#f59e0b",
  general: "#6b7280",
}

function now(): number {
  return Date.now()
}

function agentID(): string {
  return `agent_${now()}_${Math.random().toString(36).slice(2, 8)}`
}

function makeMockAgents(): AgentState[] {
  return [
    {
      id: agentID(),
      name: "Planner",
      role: "planner",
      status: "thinking",
      color: ROLE_COLORS.planner,
      currentThinking:
        "Mapping the codebase to find integration points for the agent panel. The session-viz context has a coordination event handler pattern we can reuse. Key files: session-viz.tsx, viz-panel.tsx, activity-feed.tsx.",
      currentTool: "read_source",
      currentToolResult: "Found 3 files with coordination patterns",
      editedFiles: ["packages/app/src/context/agent-collaboration.tsx"],
      recentActivity: [
        { type: "file_edit", summary: "Created agent-collaboration context", timestamp: now() - 2000 },
        { type: "tool_call", summary: "Read session-viz.tsx (589 lines)", timestamp: now() - 15000 },
        { type: "thinking", summary: "Analyzing coordination event flow", timestamp: now() - 30000 },
      ],
    },
    {
      id: agentID(),
      name: "Coder",
      role: "coder",
      status: "working",
      color: ROLE_COLORS.coder,
      currentThinking: "Building the agent column component with Tailwind classes. Need semantic tokens: --surface-base, --border-base, --text-base. Active work on agent-column.tsx.",
      currentTool: "smart_write",
      currentToolResult: "Created agent-column.tsx",
      editedFiles: [
        "packages/app/src/components/agent-collaboration/agent-column.tsx",
        "packages/app/src/components/agent-collaboration/agent-collaboration.css",
      ],
      recentActivity: [
        { type: "file_edit", summary: "Wrote agent-column.tsx", timestamp: now() - 5000 },
        { type: "file_edit", summary: "Wrote agent-collaboration.css", timestamp: now() - 12000 },
        { type: "tool_call", summary: "Built CSS animation keyframes", timestamp: now() - 25000 },
      ],
    },
    {
      id: agentID(),
      name: "Reviewer",
      role: "reviewer",
      status: "idle",
      color: ROLE_COLORS.reviewer,
      editedFiles: [],
      recentActivity: [
        { type: "session_status", summary: "Awaiting code to review", timestamp: now() - 60000 },
      ],
    },
  ]
}

export const { use: useAgentCollaboration, provider: AgentCollaborationProvider } = createSimpleContext({
  name: "AgentCollaboration",
  init: () => {
    const [agents, setAgents] = createStore<Record<string, AgentState>>({})
    const [isOpen, setIsOpen] = createSignal(false)

    // Seed mock agents
    for (const agent of makeMockAgents()) {
      setAgents(agent.id, agent)
    }

    function toggle() {
      setIsOpen((prev) => !prev)
    }

    function addAgent(agent: AgentState) {
      setAgents(agent.id, agent)
    }

    function removeAgent(id: string) {
      setAgents(
        produce((draft) => {
          delete draft[id]
        }),
      )
    }

    function setAgentStatus(id: string, status: AgentStatus) {
      const agent = agents[id]
      if (!agent) return
      setAgents(id, "status", status)
      addActivity(id, "session_status", `Status: ${status}`)
    }

    function setAgentThinking(id: string, text: string) {
      const agent = agents[id]
      if (!agent) return
      setAgents(id, "currentThinking", text)
      setAgents(id, "status", "thinking")
    }

    function appendAgentThinking(id: string, text: string) {
      const agent = agents[id]
      if (!agent) return
      const existing = agent.currentThinking ?? ""
      setAgents(id, "currentThinking", existing ? `${existing}\n${text}` : text)
      if (agent.status !== "thinking") {
        setAgents(id, "status", "thinking")
      }
    }

    function setAgentTool(id: string, tool: string, result?: string) {
      const agent = agents[id]
      if (!agent) return
      setAgents(id, "currentTool", tool)
      setAgents(id, "currentToolResult", result)
      setAgents(id, "status", "working")
      addActivity(id, "tool_call", `Tool: ${tool}${result ? ` — ${result.slice(0, 60)}` : ""}`)
    }

    function addEditedFile(id: string, file: string) {
      const agent = agents[id]
      if (!agent) return
      setAgents(id, "editedFiles", (prev) => {
        if (prev.includes(file)) return prev
        return [...prev, file]
      })
      addActivity(id, "file_edit", `Edited ${file}`)
    }

    function addActivity(id: string, type: string, summary: string) {
      const agent = agents[id]
      if (!agent) return
      const entry: ActivityEntry = { type, summary, timestamp: now() }
      setAgents(id, "recentActivity", (prev) => {
        const next = [entry, ...prev]
        if (next.length > 20) next.length = 20
        return next
      })
    }

    return {
      agents: () => Object.values(agents),
      activeAgent: () => {
        const vals = Object.values(agents)
        const active = vals.find((a) => a.status === "thinking" || a.status === "working")
        return active ?? vals[0]
      },
      setAgentStatus,
      setAgentThinking,
      appendAgentThinking,
      setAgentTool,
      addEditedFile,
      addActivity,
      removeAgent,
      addAgent,
      isOpen,
      toggle,
    }
  },
})
