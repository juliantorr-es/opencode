import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Wildcard } from "@/util/wildcard"
import { Tool } from "@/tool/tool"

// ─── Mode ────────────────────────────────────────────────────────────────────

export const AuthorityMode = Schema.Literals([
  "investigate",
  "patch",
  "refactor",
  "review",
  "autopilot",
  "rescue",
]).annotate({ identifier: "AuthorityMode" })
export type AuthorityMode = Schema.Schema.Type<typeof AuthorityMode>

// ─── Stop Condition ──────────────────────────────────────────────────────────

export const StopCondition = Schema.Literals([
  "ambiguity_detected",
  "unexpected_file_write",
  "typecheck_failure",
  "test_failure",
  "blocking_question_needed",
  "no_checkpoint_without_passing_tests",
  "diff_must_be_shown",
  "touch_set_preview_required",
  "findings_must_be_recorded",
  "event_logging_strict",
  "broken_state_focused",
]).annotate({ identifier: "StopCondition" })
export type StopCondition = Schema.Schema.Type<typeof StopCondition>

// ─── Contract ────────────────────────────────────────────────────────────────

export const AuthorityContract = Schema.Struct(
  {
    mode: AuthorityMode,
    mayRead: Schema.mutable(Schema.Array(Schema.String)).annotate({
      description: "Glob patterns for files the mode may read",
    }),
    mayWrite: Schema.mutable(Schema.Array(Schema.String)).annotate({
      description: "Glob patterns for files the mode may write",
    }),
    mustNotWrite: Schema.mutable(Schema.Array(Schema.String)).annotate({
      description: "Glob patterns the mode is explicitly forbidden from writing (overrides mayWrite)",
    }),
    mayRun: Schema.mutable(Schema.Array(Schema.String)).annotate({
      description: "Tool names the mode may execute without asking",
    }),
    mustAskBefore: Schema.mutable(Schema.Array(Schema.String)).annotate({
      description: "Tool names the mode must prompt before executing",
    }),
    stopConditions: Schema.mutable(Schema.Array(StopCondition)).annotate({
      description: "Conditions that trigger a stop-and-escalate",
    }),
  },
).annotate({ identifier: "AuthorityContract" })
export type AuthorityContract = Schema.Schema.Type<typeof AuthorityContract>

// ─── Tagged Errors ───────────────────────────────────────────────────────────

export class WriteViolationError extends Schema.TaggedErrorClass<WriteViolationError>()(
  "AuthorityWriteViolationError",
  {
    tool: Schema.String,
    file: Schema.String,
    mode: AuthorityMode,
    detail: Schema.String,
  },
) {}

export class ReadViolationError extends Schema.TaggedErrorClass<ReadViolationError>()(
  "AuthorityReadViolationError",
  {
    tool: Schema.String,
    file: Schema.String,
    mode: AuthorityMode,
    detail: Schema.String,
  },
) {}

export class ToolViolationError extends Schema.TaggedErrorClass<ToolViolationError>()(
  "AuthorityToolViolationError",
  {
    tool: Schema.String,
    mode: AuthorityMode,
    action: Schema.Literals(["denied", "must_ask"]),
    detail: Schema.String,
  },
) {}

export class StopConditionTriggeredError extends Schema.TaggedErrorClass<StopConditionTriggeredError>()(
  "AuthorityStopConditionError",
  {
    tool: Schema.String,
    condition: StopCondition,
    mode: AuthorityMode,
    detail: Schema.String,
  },
) {}

export type AuthorityError = WriteViolationError | ReadViolationError | ToolViolationError | StopConditionTriggeredError

// ─── Interface ───────────────────────────────────────────────────────────────

export interface Interface {
  readonly getContract: () => Effect.Effect<AuthorityContract>
  readonly setMode: (mode: AuthorityMode) => Effect.Effect<AuthorityContract>
  readonly setContract: (contract: AuthorityContract) => Effect.Effect<void>
  readonly checkToolAllowed: (toolId: string) => Effect.Effect<void, ToolViolationError>
  readonly checkFileReadable: (filePath: string) => Effect.Effect<void, ReadViolationError>
  readonly checkFileWritable: (filePath: string) => Effect.Effect<void, WriteViolationError>
  readonly checkStopCondition: (condition: StopCondition) => Effect.Effect<boolean>
  readonly requireStopCondition: (
    condition: StopCondition,
    tool: string,
  ) => Effect.Effect<void, StopConditionTriggeredError>
  readonly toContext: () => Effect.Effect<AuthorityContract>
}

// ─── Default Contracts by Mode ───────────────────────────────────────────────

const DEFAULT_CONTRACTS: Record<AuthorityMode, AuthorityContract> = {
  investigate: {
    mode: "investigate",
    mayRead: ["**/*"],
    mayWrite: [],
    mustNotWrite: ["**/*"],
    mayRun: [
      "read_source",
      "smart_grep",
      "smart_find",
      "smart_git",
      "read_artifact",
      "read_messages",
      "task_board",
      "discover_findings",
      "curate_context",
      "youtube-transcript_get_transcript",
    ],
    mustAskBefore: ["smart_bash", "smart_bun", "analytics"],
    stopConditions: ["blocking_question_needed"],
  },
  patch: {
    mode: "patch",
    mayRead: ["**/*"],
    mayWrite: [
      "packages/opencode/src/**/*.ts",
      "packages/opencode/src/**/*.tsx",
      "packages/opencode/src/**/*.json",
      "packages/opencode/tests/**/*.ts",
    ],
    mustNotWrite: ["packages/opencode/node_modules/**", "**/node_modules/**", "**/.git/**"],
    mayRun: [
      "read_source",
      "smart_grep",
      "smart_find",
      "smart_git",
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "search_replace",
      "read_artifact",
      "read_messages",
      "task_board",
      "discover_findings",
      "smart_bash",
      "smart_bun",
      "propose_plan",
      "revise_plan",
      "review_criticism",
      "session_diff",
      "prepare_checkpoint",
      "publish_checkpoint",
      "roadmap_progress",
      "lesson_register",
      "tool_feedback",
      "out_of_scope_finding",
      "generate_report",
      "log_activity",
      "validate",
    ],
    mustAskBefore: ["smart_bun", "smart_bash"],
    stopConditions: [
      "diff_must_be_shown",
      "no_checkpoint_without_passing_tests",
      "typecheck_failure",
      "blocking_question_needed",
    ],
  },
  refactor: {
    mode: "refactor",
    mayRead: ["**/*"],
    mayWrite: ["packages/opencode/src/**/*.ts", "packages/opencode/src/**/*.tsx"],
    mustNotWrite: ["**/node_modules/**", "**/.git/**", "**/*.snapshot.*"],
    mayRun: [
      "read_source",
      "smart_grep",
      "smart_find",
      "smart_git",
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "search_replace",
      "read_artifact",
      "read_messages",
      "task_board",
      "discover_findings",
      "smart_bash",
      "smart_bun",
      "propose_plan",
      "revise_plan",
      "review_criticism",
      "session_diff",
      "prepare_checkpoint",
      "publish_checkpoint",
      "roadmap_progress",
      "lesson_register",
      "tool_feedback",
      "out_of_scope_finding",
      "generate_report",
      "log_activity",
    ],
    mustAskBefore: ["smart_bun", "smart_bash", "smart_write", "smart_batch"],
    stopConditions: [
      "touch_set_preview_required",
      "no_checkpoint_without_passing_tests",
      "typecheck_failure",
      "test_failure",
      "blocking_question_needed",
    ],
  },
  review: {
    mode: "review",
    mayRead: ["**/*"],
    mayWrite: [],
    mustNotWrite: ["**/*"],
    mayRun: [
      "read_source",
      "smart_grep",
      "smart_find",
      "smart_git",
      "read_artifact",
      "read_messages",
      "task_board",
      "discover_findings",
      "curate_context",
      "review_criticism",
      "smart_bash",
      "smart_bun",
      "lesson_register",
      "tool_feedback",
      "out_of_scope_finding",
      "log_activity",
    ],
    mustAskBefore: ["smart_bash", "smart_bun"],
    stopConditions: ["findings_must_be_recorded", "blocking_question_needed"],
  },
  autopilot: {
    mode: "autopilot",
    mayRead: ["**/*"],
    mayWrite: [],
    mustNotWrite: ["**/*"],
    mayRun: [
      "read_source",
      "smart_grep",
      "smart_find",
      "smart_git",
      "read_artifact",
      "read_messages",
      "task_board",
      "discover_findings",
      "smart_bash",
      "smart_bun",
      "lesson_register",
      "tool_feedback",
      "log_activity",
    ],
    mustAskBefore: ["smart_write", "smart_batch", "smart_sd", "replace_symbol", "search_replace"],
    stopConditions: ["event_logging_strict", "ambiguity_detected", "blocking_question_needed"],
  },
  rescue: {
    mode: "rescue",
    mayRead: ["**/*"],
    mayWrite: ["**/*"],
    mustNotWrite: ["**/node_modules/**", "**/.git/**"],
    mayRun: [
      "read_source",
      "smart_grep",
      "smart_find",
      "smart_git",
      "smart_write",
      "smart_batch",
      "smart_sd",
      "replace_symbol",
      "search_replace",
      "read_artifact",
      "read_messages",
      "task_board",
      "discover_findings",
      "smart_bash",
      "smart_bun",
      "session_diff",
      "prepare_checkpoint",
      "publish_checkpoint",
      "roadmap_progress",
      "lesson_register",
      "tool_feedback",
      "log_activity",
    ],
    mustAskBefore: ["smart_bun", "smart_bash", "smart_write", "smart_batch"],
    stopConditions: ["broken_state_focused", "blocking_question_needed"],
  },
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function matchesAny(filePath: string, globs: string[]): boolean {
  return globs.some((g) => Wildcard.match(filePath, g))
}

function describe(globs: string[]): string {
  if (globs.length === 0) return "(none)"
  if (globs.length <= 3) return globs.join(", ")
  return `${globs.slice(0, 3).join(", ")}, +${globs.length - 3} more`
}

/** Schema for a contract overridable from configuration. */
export const PartialContractOverride = Schema.Struct({
  mayRead: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  mayWrite: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  mustNotWrite: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  mayRun: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  mustAskBefore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  stopConditions: Schema.optional(Schema.mutable(Schema.Array(StopCondition))),
}).annotate({ identifier: "PartialContractOverride" })
export type PartialContractOverride = Schema.Schema.Type<typeof PartialContractOverride>

/** Merge a partial override into a contract. */
export function applyOverride(base: AuthorityContract, override: PartialContractOverride): AuthorityContract {
  return {
    mode: base.mode,
    mayRead: override.mayRead ?? base.mayRead,
    mayWrite: override.mayWrite ?? base.mayWrite,
    mustNotWrite: override.mustNotWrite ?? base.mustNotWrite,
    mayRun: override.mayRun ?? base.mayRun,
    mustAskBefore: override.mustAskBefore ?? base.mustAskBefore,
    stopConditions: override.stopConditions ?? base.stopConditions,
  }
}

/** Retrieve the default contract for a mode. */
export function defaultContractFor(mode: AuthorityMode): AuthorityContract {
  return { ...DEFAULT_CONTRACTS[mode] }
}

// ─── Service Implementation ──────────────────────────────────────────────────

export class Service extends Context.Service<Service, Interface>()("@opencode/Authority") {}

const make = Effect.gen(function* () {
  const contract = yield* Ref.make<AuthorityContract>(DEFAULT_CONTRACTS.investigate)

  const getter: Effect.Effect<AuthorityContract> = Ref.get(contract)
  const setter = (c: AuthorityContract) => Ref.set(contract, c)

  return {
    getContract: (): Effect.Effect<AuthorityContract> => getter,

    setMode: (mode: AuthorityMode): Effect.Effect<AuthorityContract> => {
      const updated = { ...DEFAULT_CONTRACTS[mode] }
      return setter(updated).pipe(Effect.as(updated))
    },

    setContract: (c: AuthorityContract): Effect.Effect<void> => setter(c),

    checkToolAllowed: (toolId: string): Effect.Effect<void, ToolViolationError> =>
      getter.pipe(
        Effect.flatMap((c) => {
          if (c.mustAskBefore.includes(toolId)) {
            return Effect.fail(
              new ToolViolationError({
                tool: toolId,
                mode: c.mode,
                action: "must_ask",
                detail: `Tool "${toolId}" requires explicit approval in "${c.mode}" mode`,
              }),
            )
          }
          if (!c.mayRun.includes(toolId)) {
            return Effect.fail(
              new ToolViolationError({
                tool: toolId,
                mode: c.mode,
                action: "denied",
                detail: `Tool "${toolId}" is not in the allowed list for "${c.mode}" mode. Allowed: ${describe(c.mayRun)}. Must-ask: ${describe(c.mustAskBefore)}.`,
              }),
            )
          }
          return Effect.void
        }),
      ),

    checkFileReadable: (filePath: string): Effect.Effect<void, ReadViolationError> =>
      getter.pipe(
        Effect.flatMap((c) => {
          if (!matchesAny(filePath, c.mayRead)) {
            return Effect.fail(
              new ReadViolationError({
                tool: "(implicit)",
                file: filePath,
                mode: c.mode,
                detail: `File "${filePath}" does not match any mayRead glob in "${c.mode}" mode. Allowed: ${describe(c.mayRead)}`,
              }),
            )
          }
          return Effect.void
        }),
      ),

    checkFileWritable: (filePath: string): Effect.Effect<void, WriteViolationError> =>
      getter.pipe(
        Effect.flatMap((c) => {
          if (matchesAny(filePath, c.mustNotWrite)) {
            return Effect.fail(
              new WriteViolationError({
                tool: "(implicit)",
                file: filePath,
                mode: c.mode,
                detail: `File "${filePath}" matches a mustNotWrite glob in "${c.mode}" mode. Blocked: ${describe(c.mustNotWrite)}`,
              }),
            )
          }
          if (!matchesAny(filePath, c.mayWrite)) {
            return Effect.fail(
              new WriteViolationError({
                tool: "(implicit)",
                file: filePath,
                mode: c.mode,
                detail: `File "${filePath}" does not match any mayWrite glob in "${c.mode}" mode. Allowed: ${describe(c.mayWrite)}`,
              }),
            )
          }
          return Effect.void
        }),
      ),

    checkStopCondition: (condition: StopCondition): Effect.Effect<boolean> =>
      getter.pipe(Effect.map((c) => c.stopConditions.includes(condition))),

    requireStopCondition: (condition: StopCondition, tool: string): Effect.Effect<void, StopConditionTriggeredError> =>
      getter.pipe(
        Effect.flatMap((c) => {
          if (c.stopConditions.includes(condition)) {
            return Effect.fail(
              new StopConditionTriggeredError({
                tool,
                condition,
                mode: c.mode,
                detail: `Stop condition "${condition}" is active in "${c.mode}" mode for tool "${tool}"`,
              }),
            )
          }
          return Effect.void
        }),
      ),

    toContext: (): Effect.Effect<AuthorityContract> => getter,
  } satisfies Interface
})

export const layer: Layer.Layer<Service> = Layer.effect(Service, make)

export const Authority = { Service, layer }

// ─── Convenience Accessor ────────────────────────────────────────────────────

import { serviceUse } from "@opencode-ai/core/effect/service-use"
export const use = serviceUse(Service)

// ─── PhaseGate / Tool Pipeline Integration ───────────────────────────────────

/**
 * Build a gate that surfaces authority contract checks as Tool.ToolError failures,
 * matching the shape expected by the tool execution pipeline (session/tools.ts).
 */
export const buildToolGate = Effect.fn("Authority.buildToolGate")(function* () {
  const authority = yield* Service
  return {
    checkToolAllowed: (toolId: string): Effect.Effect<void, Tool.ToolError> =>
      authority.checkToolAllowed(toolId).pipe(
        Effect.catch((err) =>
          Effect.fail(
            new Tool.ToolError({
              tool: toolId,
              detail: err.detail,
              recoverable: true,
            }),
          ),
        ),
      ),
    checkFileWritable: (filePath: string, toolId: string): Effect.Effect<void, Tool.ToolError> =>
      authority.checkFileWritable(filePath).pipe(
        Effect.catch((err) =>
          Effect.fail(
            new Tool.ToolError({
              tool: toolId,
              detail: err.detail,
              recoverable: true,
            }),
          ),
        ),
      ),
    checkFileReadable: (filePath: string, toolId: string): Effect.Effect<void, Tool.ToolError> =>
      authority.checkFileReadable(filePath).pipe(
        Effect.catch((err) =>
          Effect.fail(
            new Tool.ToolError({
              tool: toolId,
              detail: err.detail,
              recoverable: true,
            }),
          ),
        ),
      ),
  }
})
