import { Schema } from "effect"

/**
 * A single phase in an agent lifecycle.
 * Each phase can gate tool access, spawn subagents, and define retry behavior.
 */
export const PhaseSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  fanOut: Schema.optional(Schema.Boolean),
  subagents: Schema.optional(Schema.Array(Schema.String)),
  requiresAll: Schema.optional(Schema.Boolean),
  maxRetries: Schema.optional(Schema.Int),
  escalation: Schema.optional(Schema.Literals(["blocker", "skip", "abort"])),
})
export interface Phase {
  name: string
  description?: string
  allowedTools?: string[]
  fanOut?: boolean
  subagents?: string[]
  requiresAll?: boolean
  maxRetries?: number
  escalation?: "blocker" | "skip" | "abort"
}

export const TransitionSchema = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  condition: Schema.Literals(["success", "failure", "always"]),
})
export interface Transition {
  from: string
  to: string
  condition: "success" | "failure" | "always"
}

export const LifecycleDefinitionSchema = Schema.Struct({
  type: Schema.Literals(["linear", "dag", "generic"]),
  phases: Schema.Array(PhaseSchema),
  transitions: Schema.Array(TransitionSchema),
})
export interface LifecycleDefinition {
  type: "linear" | "dag" | "generic"
  phases: Phase[]
  transitions: Transition[]
}

export const PhaseResultSchema = Schema.Struct({
  phase: Schema.String,
  status: Schema.Literals(["completed", "failed", "skipped", "escalated"]),
  error: Schema.optional(Schema.String),
  retriesUsed: Schema.Int,
})

export interface PhaseResult {
  phase: string
  status: "completed" | "failed" | "skipped" | "escalated"
  error?: string
  retriesUsed: number
}

export const EngineInputSchema = Schema.Struct({
  session: Schema.Any,
  agent: Schema.Any,
  lifecycle: LifecycleDefinitionSchema,
  processorHandle: Schema.Any,
})

export interface EngineInput {
  session: any
  agent: any
  lifecycle: LifecycleDefinition
  processorHandle: any
}

// Built-in lifecycle definitions are in builtins.ts
