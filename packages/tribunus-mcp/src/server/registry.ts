import type { Capability } from "../governance/capabilities.js"
import type { InvocationContext } from "../governance/invocation-context.js"

export type ToolInputSchema = {
  type: "object"
  properties: Record<string, {
    type?: string
    enum?: string[]
    items?: { type: string }
    description?: string
  }>
  required: string[]
}

export interface RegisteredTool {
  name: string
  description: string
  inputSchema: ToolInputSchema
  requiredCapabilities: Capability[]
  aliases?: string[]
  timeoutMs: number
  execute(ctx: InvocationContext, input: Record<string, unknown>): Promise<unknown>
}

const registry = new Map<string, RegisteredTool>()
const aliasMap = new Map<string, string>()

export function registerTool(tool: RegisteredTool): void {
  registry.set(tool.name, tool)
  if (tool.aliases) {
    for (const alias of tool.aliases) {
      aliasMap.set(alias, tool.name)
    }
  }
}

export function resolveTool(name: string): RegisteredTool | undefined {
  const direct = registry.get(name)
  if (direct) return direct
  const canonicalName = aliasMap.get(name)
  if (canonicalName) return registry.get(canonicalName)
  return undefined
}

export function listTools(): RegisteredTool[] {
  return Array.from(registry.values())
}

export function getToolCount(): number {
  return registry.size
}
