import type { AgentDef } from "@/types/agent"

export interface AgentStudioConfig {
  id: string
  name: string
  role: "planner" | "coder" | "reviewer" | "tester" | "custom"
  systemPrompt: string
  model: string
  temperature: number
  topP: number
  maxTokens: number
  enabledTools: string[]
  color: string
  isBuiltin: boolean
  isActive: boolean
}

export const AVAILABLE_TOOLS = [
  { id: "read_source", name: "Read Source", description: "Read source files" },
  { id: "smart_grep", name: "Search Code", description: "Pattern search in codebase" },
  { id: "smart_find", name: "Find Files", description: "Search for files" },
  { id: "smart_edit", name: "Edit Files", description: "Make edits to files" },
  { id: "smart_bash", name: "Run Commands", description: "Execute shell commands" },
  { id: "smart_git", name: "Git Operations", description: "Git status, diff, commit" },
  { id: "smart_bun", name: "Bun Runner", description: "Run tests, typecheck" },
  { id: "web_search", name: "Web Search", description: "Search the web" },
  { id: "web_fetch", name: "Web Fetch", description: "Fetch URLs" },
]

export const AVAILABLE_MODELS = [
  "gpt-4o", "gpt-4o-mini", "claude-sonnet-4", "claude-haiku-4",
  "gemini-2.5-pro", "deepseek-v3", "deepseek-r1",
]

export const ROLE_COLORS: Record<string, string> = {
  planner: "#8b5cf6",
  coder: "#3b82f6",
  reviewer: "#22c55e",
  tester: "#f59e0b",
  custom: "#6b7280",
}

export const DEFAULT_BUILTIN_AGENTS: AgentStudioConfig[] = [
  {
    id: "build",
    name: "Build",
    role: "coder",
    systemPrompt: "You are a full-access development agent. You can read, write, and execute code freely. Focus on producing working solutions.",
    model: "claude-sonnet-4",
    temperature: 0.3,
    topP: 0.9,
    maxTokens: 8192,
    enabledTools: AVAILABLE_TOOLS.map((t) => t.id),
    color: "#3b82f6",
    isBuiltin: true,
    isActive: true,
  },
  {
    id: "plan",
    name: "Plan",
    role: "planner",
    systemPrompt: "You are a read-only planning agent. You analyze codebases, design architectures, and produce plans. You never write code directly.",
    model: "claude-sonnet-4",
    temperature: 0.5,
    topP: 0.9,
    maxTokens: 8192,
    enabledTools: ["read_source", "smart_grep", "smart_find", "web_search", "web_fetch"],
    color: "#8b5cf6",
    isBuiltin: true,
    isActive: true,
  },
  {
    id: "review",
    name: "Review",
    role: "reviewer",
    systemPrompt: "You are a code reviewer. Analyze code for bugs, style issues, security vulnerabilities, and performance problems. Provide constructive feedback.",
    model: "claude-sonnet-4",
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 4096,
    enabledTools: ["read_source", "smart_grep", "smart_find"],
    color: "#22c55e",
    isBuiltin: true,
    isActive: true,
  },
]

export function studioConfigToAgentDef(config: AgentStudioConfig): AgentDef {
  return {
    id: config.id,
    name: config.name,
    prompt: config.systemPrompt,
    model: config.model || undefined,
    variant: config.role === "custom" ? undefined : config.role,
    temperature: config.temperature,
    top_p: config.topP,
    color: config.color || undefined,
  }
}
