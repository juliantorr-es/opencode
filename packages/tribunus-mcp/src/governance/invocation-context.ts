import { AsyncLocalStorage } from "node:async_hooks"
import type { InvocationReceipt } from "./receipts.js"
import type { Capability } from "./capabilities.js"
import type { ResourceBudget } from "./limits.js"

export interface InvocationContext {
  invocationId: string
  toolName: string
  capabilities: Set<Capability>
  receipt: InvocationReceipt
  budget: ResourceBudget
  signal: AbortSignal
  envPolicyDigest: string
  startedAt: number
}

const storage = new AsyncLocalStorage<InvocationContext>()

export function getInvocationContext(): InvocationContext {
  const ctx = storage.getStore()
  if (!ctx) throw new Error("No active invocation context — called outside MCP request handler")
  return ctx
}

export function runWithContext<T>(ctx: InvocationContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn)
}
