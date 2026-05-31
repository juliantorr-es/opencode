import { Effect, Schema } from "effect"

export const LifecycleType = Schema.Literals(["linear", "dag", "generic"])
export type LifecycleType = Schema.Schema.Type<typeof LifecycleType>

export const EscalationStrategy = Schema.Literals(["blocker", "skip", "abort"])
export type EscalationStrategy = Schema.Schema.Type<typeof EscalationStrategy>

export const TransitionCondition = Schema.Literals(["success", "failure", "always", "timeout"])
export type TransitionCondition = Schema.Schema.Type<typeof TransitionCondition>

export class PhaseDefinition extends Schema.Class<PhaseDefinition>("PhaseDefinition")({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  maxRetries: Schema.optional(Schema.Number).pipe(Schema.withDecodingDefault(Effect.sync(() => 0))),
  escalation: Schema.optional(EscalationStrategy).pipe(Schema.withDecodingDefault(Effect.sync(() => "skip" as const))),
  fanOut: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(Effect.sync(() => false))),
  subagentTypes: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
}) {}

export class TransitionDefinition extends Schema.Class<TransitionDefinition>("TransitionDefinition")({
  from: Schema.String,
  to: Schema.String,
  condition: TransitionCondition,
}) {}

export class LifecycleDefinition extends Schema.Class<LifecycleDefinition>("LifecycleDefinition")({
  type: LifecycleType,
  phases: Schema.mutable(Schema.Array(PhaseDefinition)),
  transitions: Schema.optional(Schema.mutable(Schema.Array(TransitionDefinition))),
}) {}

export interface PhaseResult {
  phase: string
  status: "completed" | "failed" | "skipped" | "escalated"
  error?: string
  retriesUsed: number
}

export class PhaseFailureError {
  readonly _tag = "PhaseFailureError"
  constructor(
    readonly phase: string,
    readonly status: "failed" | "skipped" | "escalated",
    readonly error: string,
    readonly retriesUsed: number,
    readonly escalation: EscalationStrategy,
  ) {}
}

/**
 * Safely parse an unknown value into a LifecycleDefinition.
 * Returns undefined if the value doesn't match the schema.
 */
export function parseLifecycle(value: unknown): LifecycleDefinition | undefined {
  const result = Schema.decodeOption(LifecycleDefinition)(value)
  if (result._tag === "None") return undefined
  return result.value
}

export function getNextPhase(
  lifecycle: LifecycleDefinition,
  currentPhaseId: string,
  status: "completed" | "failed",
): string | undefined {
  if (lifecycle.type === "linear") {
    const index = lifecycle.phases.findIndex((p) => p.id === currentPhaseId)
    if (index < 0) return undefined
    if (status === "failed" && lifecycle.phases[index].escalation === "skip") {
      return lifecycle.phases[index + 1]?.id
    }
    return lifecycle.phases[index + 1]?.id
  }

  // dag — find a matching transition
  const transitions = lifecycle.transitions ?? []
  const condition = status === "completed" ? "success" : "failure"
  const match = transitions.find(
    (t) => t.from === currentPhaseId && (t.condition === condition || t.condition === "always"),
  )
  return match?.to
}
