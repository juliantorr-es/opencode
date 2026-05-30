import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"

export interface ContextNode {
  id: string
  label: string
  type: "file" | "directory" | "pattern" | "concept" | "dependency"
  path?: string
  size: number
  color: string
  x: number
  y: number
}

export interface ContextEdge {
  source: string
  target: string
  label?: string
  strength: number
}

export interface AgentContext {
  nodes: ContextNode[]
  edges: ContextEdge[]
  focusNodeId?: string
}

const DEMO_NODES: ContextNode[] = [
  { id: "app", label: "App", type: "directory", size: 80, color: "#8b5cf6", x: 0, y: 0 },
  { id: "core", label: "Core", type: "directory", size: 65, color: "#8b5cf6", x: 0, y: 0 },
  { id: "components", label: "Components", type: "directory", size: 60, color: "#8b5cf6", x: 0, y: 0 },
  { id: "app-tsx", label: "app.tsx", type: "file", size: 85, color: "#3b82f6", x: 0, y: 0 },
  { id: "button-tsx", label: "Button.tsx", type: "file", size: 60, color: "#3b82f6", x: 0, y: 0 },
  { id: "store-ts", label: "store.ts", type: "file", size: 70, color: "#3b82f6", x: 0, y: 0 },
  { id: "api-ts", label: "api.ts", type: "file", size: 55, color: "#3b82f6", x: 0, y: 0 },
  { id: "hooks-pat", label: "Hooks", type: "pattern", size: 50, color: "#22c55e", x: 0, y: 0 },
  { id: "provider-pat", label: "Providers", type: "pattern", size: 45, color: "#22c55e", x: 0, y: 0 },
  { id: "auth", label: "Auth", type: "concept", size: 55, color: "#f59e0b", x: 0, y: 0 },
  { id: "routing", label: "Routing", type: "concept", size: 40, color: "#f59e0b", x: 0, y: 0 },
  { id: "solid-js", label: "solid-js", type: "dependency", size: 50, color: "#ef4444", x: 0, y: 0 },
  { id: "effect", label: "Effect", type: "dependency", size: 45, color: "#ef4444", x: 0, y: 0 },
]

const DEMO_EDGES: ContextEdge[] = [
  { source: "app", target: "app-tsx", strength: 0.9 },
  { source: "app", target: "core", strength: 0.7 },
  { source: "app", target: "components", strength: 0.7 },
  { source: "core", target: "store-ts", strength: 0.8 },
  { source: "core", target: "api-ts", strength: 0.6 },
  { source: "components", target: "button-tsx", strength: 0.8 },
  { source: "app-tsx", target: "button-tsx", strength: 0.5 },
  { source: "app-tsx", target: "routing", strength: 0.4 },
  { source: "core", target: "auth", strength: 0.6 },
  { source: "core", target: "hooks-pat", strength: 0.7 },
  { source: "components", target: "hooks-pat", strength: 0.5 },
  { source: "components", target: "provider-pat", strength: 0.5 },
  { source: "solid-js", target: "components", strength: 0.4 },
  { source: "solid-js", target: "app-tsx", strength: 0.3 },
  { source: "effect", target: "core", strength: 0.4 },
  { source: "effect", target: "store-ts", strength: 0.3 },
]

function createAgentContextState() {
  const [context, setContext] = createStore<AgentContext>({
    nodes: DEMO_NODES,
    edges: DEMO_EDGES,
  })
  const [isOpen, setIsOpen] = createSignal(false)

  const toggle = () => setIsOpen((prev) => !prev)

  const focusNode = (id: string) => {
    setContext("focusNodeId", id)
  }

  const clearFocus = () => {
    setContext("focusNodeId", undefined)
  }

  const addNode = (node: ContextNode) => {
    setContext("nodes", (prev) => [...prev, node])
  }

  const addEdge = (edge: ContextEdge) => {
    setContext("edges", (prev) => [...prev, edge])
  }

  return { context, setContext, isOpen, toggle, focusNode, clearFocus, addNode, addEdge }
}

export type AgentContextType = ReturnType<typeof createAgentContextState>

export const { use: useAgentContext, provider: AgentContextProvider } = createSimpleContext({
  name: "AgentContext",
  gate: false,
  init: () => createAgentContextState(),
})
