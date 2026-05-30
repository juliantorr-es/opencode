import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Tool from "./tool"
import { PhaseGate } from "@/lifecycle/gate"

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToolStatus = "succeeded" | "failed" | "denied" | "cancelled"

export interface ToolFailure {
  test?: string
  file?: string
  line?: number
  message: string
}

export interface NextAffordance {
  action: string
  target?: string
  command?: string
}

/**
 * TypedToolResult carries structured failure/success info alongside the tool's
 * data output. Every tool execution wraps its return value in this type so that
 * downstream consumers (the model, UI, logging) always get typed error info,
 * suggested next tools, and next affordances.
 *
 * @type T The type of the success data payload.
 */
export interface TypedToolResult<T = unknown> {
  tool: string
  status: ToolStatus
  errorKind?: string
  recoverable: boolean
  summary: string
  data: T
  failures?: ToolFailure[]
  suggestedNextTools: string[]
  nextAffordances: NextAffordance[]
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const ToolFailureSchema = Schema.Struct({
  test: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
  message: Schema.String,
}).annotate({ identifier: "ToolFailure" })

export const NextAffordanceSchema = Schema.Struct({
  action: Schema.String,
  target: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
}).annotate({ identifier: "NextAffordance" })

const StatusSchema = Schema.Union(
  [Schema.Literal("succeeded"), Schema.Literal("failed"), Schema.Literal("denied"), Schema.Literal("cancelled")],
)

export const TypedToolResultSchema = Schema.Struct({
  tool: Schema.String,
  status: StatusSchema,
  errorKind: Schema.optional(Schema.String),
  recoverable: Schema.Boolean,
  summary: Schema.String,
  data: Schema.Unknown,
  failures: Schema.optional(Schema.Array(ToolFailureSchema)),
  suggestedNextTools: Schema.Array(Schema.String),
  nextAffordances: Schema.Array(NextAffordanceSchema),
}).annotate({ identifier: "TypedToolResult" })

// ─── Constructors ─────────────────────────────────────────────────────────────

export function makeSuccess<T>(tool: string, data: T, summary: string): TypedToolResult<T> {
  return {
    tool,
    status: "succeeded",
    recoverable: true,
    summary,
    data,
    suggestedNextTools: suggestedToolsAfterSuccess(tool),
    nextAffordances: affordancesAfterSuccess(tool),
  }
}

export function makeFailure<T>(
  tool: string,
  data: T,
  errorKind: string,
  summary: string,
  recoverable: boolean,
  failures?: ToolFailure[],
): TypedToolResult<T> {
  return {
    tool,
    status: "failed",
    errorKind,
    recoverable,
    summary,
    data,
    failures,
    suggestedNextTools: suggestedToolsFor(tool, "failed", errorKind),
    nextAffordances: affordancesFor(tool, "failed", errorKind),
  }
}

export function makeDenied<T>(tool: string, data: T, summary: string): TypedToolResult<T> {
  return {
    tool,
    status: "denied",
    errorKind: "permission_denied",
    recoverable: true,
    summary,
    data,
    suggestedNextTools: suggestedToolsFor(tool, "denied"),
    nextAffordances: affordancesFor(tool, "denied"),
  }
}

export function makeCancelled<T>(tool: string, data: T, summary: string): TypedToolResult<T> {
  return {
    tool,
    status: "cancelled",
    errorKind: "cancelled",
    recoverable: false,
    summary,
    data,
    suggestedNextTools: [],
    nextAffordances: affordancesFor(tool, "cancelled"),
  }
}

// ─── Error Classification ─────────────────────────────────────────────────────

function classifyError(error: unknown): { errorKind: string; recoverable: boolean; summary: string } {
  if (error instanceof Tool.InvalidArgumentsError) {
    return {
      errorKind: "invalid_arguments",
      recoverable: true,
      summary: error.message,
    }
  }
  if (error instanceof Tool.ToolError) {
    return {
      errorKind: error.recoverable ? "tool_error" : "fatal_tool_error",
      recoverable: error.recoverable,
      summary: error.message,
    }
  }
  if (error instanceof Tool.TimeoutError) {
    return {
      errorKind: "timeout",
      recoverable: true,
      summary: error.message,
    }
  }
  if (error instanceof Tool.TransientError) {
    return {
      errorKind: "transient",
      recoverable: true,
      summary: error.message,
    }
  }
  if (error instanceof Tool.ValidationError) {
    return {
      errorKind: "validation",
      recoverable: true,
      summary: error.message,
    }
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      errorKind: "cancelled",
      recoverable: false,
      summary: "Tool execution was aborted",
    }
  }
  return {
    errorKind: "unexpected",
    recoverable: false,
    summary: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Produce a TypedToolResult from an unknown defect.
 * Safe to call with any value — non-Error values get a generic classification.
 */
export function fromDefect(tool: string, defect: unknown): TypedToolResult<undefined> {
  const { errorKind, recoverable, summary } = classifyError(defect)
  const status: ToolStatus =
    errorKind === "cancelled" ? "cancelled"
    : errorKind === "permission_denied" ? "denied"
    : "failed"
  return {
    tool,
    status,
    errorKind,
    recoverable,
    summary,
    data: undefined,
    failures: defect instanceof Error ? [{ message: defect.message }] : undefined,
    suggestedNextTools: suggestedToolsFor(tool, status, errorKind),
    nextAffordances: affordancesFor(tool, status, errorKind),
  }
}

// ─── Affordance Resolution ────────────────────────────────────────────────────

/**
 * Known tool categories used for suggesting alternative tools.
 */
const TOOL_CATEGORIES: Record<string, string[]> = {
  read: ["read", "grep", "glob", "lsp", "repo-overview"],
  write: ["write", "edit", "glob", "read"],
  search: ["grep", "glob", "read", "websearch", "webfetch"],
  execute: ["bash", "task"],
  manage: ["checkpoint", "todo", "coordination"],
  plan: ["plan-exit", "question"],
  diagnose: ["grep", "read", "bash", "task"],
}

function toolCategory(toolID: string): string {
  if (toolID.includes("read") || toolID === "read") return "read"
  if (toolID.includes("write") || toolID === "write" || toolID.includes("edit")) return "write"
  if (toolID.includes("grep") || toolID.includes("search") || toolID.includes("find")) return "search"
  if (toolID.includes("bash") || toolID.includes("run") || toolID === "task") return "execute"
  if (toolID.includes("checkpoint") || toolID.includes("todo")) return "manage"
  if (toolID.includes("plan") || toolID.includes("question")) return "plan"
  return "diagnose"
}

function suggestedToolsAfterSuccess(toolID: string): string[] {
  const cat = toolCategory(toolID)
  const same = TOOL_CATEGORIES[cat] ?? []
  return same.filter((t) => t !== toolID)
}

function suggestedToolsFor(toolID: string, status: ToolStatus, errorKind?: string): string[] {
  if (status === "succeeded") return suggestedToolsAfterSuccess(toolID)
  if (status === "cancelled") return []

  const base = [...suggestedToolsAfterSuccess(toolID)]
  if (errorKind === "invalid_arguments" || errorKind === "timeout" || errorKind === "transient") {
    base.unshift(toolID)
  }
  if (errorKind === "permission_denied") {
    return base.filter((t) => t !== toolID)
  }
  if (errorKind === "unexpected" || errorKind === "fatal_tool_error") {
    const diag = TOOL_CATEGORIES["diagnose"] ?? []
    return [...new Set([...diag, ...base])]
  }
  return [...new Set(base)]
}

function affordancesAfterSuccess(toolID: string): NextAffordance[] {
  const cat = toolCategory(toolID)
  switch (cat) {
    case "read":
      return [
        { action: "continue_reading", target: toolID, command: "read more lines or sibling files" },
        { action: "search", target: "grep", command: "search for patterns in the read content" },
      ]
    case "write":
      return [
        { action: "verify", target: "read", command: "verify written content" },
        { action: "run_tests", command: "run tests to verify changes" },
      ]
    case "search":
      return [
        { action: "refine_search", target: toolID, command: "narrow the search pattern" },
        { action: "read", target: "read", command: "read a matching file" },
      ]
    case "execute":
      return [
        { action: "inspect_output", command: "review command output" },
        { action: "rerun", target: toolID, command: "rerun with different parameters" },
      ]
    default:
      return [
        { action: "continue", command: "proceed with the result" },
        { action: "retry", target: toolID, command: "run again if needed" },
      ]
  }
}

function affordancesFor(toolID: string, status: ToolStatus, errorKind?: string): NextAffordance[] {
  if (status === "succeeded") return affordancesAfterSuccess(toolID)
  if (status === "cancelled") return [{ action: "restart", command: "restart the session or tool call" }]

  switch (errorKind) {
    case "invalid_arguments":
      return [
        { action: "retry_with_corrected_input", target: toolID, command: "call again with valid arguments" },
        { action: "check_parameters", command: "review the tool's parameter schema" },
      ]
    case "timeout":
      return [
        { action: "retry_with_shorter_scope", target: toolID, command: "retry with reduced input size" },
        { action: "diagnose", target: "bash", command: "check if the operation is hanging" },
      ]
    case "transient":
      return [
        { action: "retry", target: toolID, command: "retry the same call" },
        { action: "retry_with_backoff", target: toolID, command: "retry after a short delay" },
      ]
    case "validation":
      return [
        { action: "fix_validation", target: toolID, command: "fix the validation error" },
        { action: "check_field", command: "verify the field value that failed validation" },
      ]
    case "permission_denied":
      return [
        { action: "request_permission", target: toolID, command: "ask for permission to use this tool" },
        { action: "try_alternative", command: "use a different tool or approach" },
      ]
    case "fatal_tool_error":
      return [
        { action: "diagnose", command: "investigate the error" },
        { action: "try_alternative", command: "use a different approach or tool" },
      ]
    default:
      return [
        { action: "diagnose", command: "investigate what went wrong" },
        { action: "retry", target: toolID, command: "retry the tool call" },
      ]
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const STRUCTURED_MARKER = "[[typed-result]]"

/**
 * Serialize a TypedToolResult into the output string the model sees.
 * The structured info is embedded as JSON after a marker so downstream
 * code can parse it back, while the text prefix gives the model a
 * human-readable failure/success signal.
 */
export function formatOutput(result: TypedToolResult): string {
  const lines: string[] = []
  if (result.status === "succeeded") {
    lines.push(`[OK] ${result.summary}`)
  } else if (result.status === "denied") {
    lines.push(`[DENIED] ${result.summary}`)
  } else if (result.status === "cancelled") {
    lines.push(`[CANCELLED] ${result.summary}`)
  } else {
    const kind = result.errorKind ?? "error"
    const hint = result.recoverable ? " (recoverable)" : ""
    lines.push(`[${kind.toUpperCase()}]${hint} ${result.summary}`)
  }

  if (result.suggestedNextTools.length > 0) {
    lines.push(`Suggested next tools: ${result.suggestedNextTools.join(", ")}`)
  }

  for (const aff of result.nextAffordances) {
    lines.push(`→ ${aff.action}${aff.target ? ` (${aff.target})` : ""}${aff.command ? `: ${aff.command}` : ""}`)
  }

  lines.push(`${STRUCTURED_MARKER}${JSON.stringify(result)}`)
  return lines.join("\n")
}

/**
 * Parse a TypedToolResult from a formatted output string.
 * Returns undefined if the output doesn't contain a typed result marker.
 */
export function parseOutput(output: string): TypedToolResult | undefined {
  const idx = output.lastIndexOf(STRUCTURED_MARKER)
  if (idx === -1) return undefined
  try {
    return JSON.parse(output.slice(idx + STRUCTURED_MARKER.length)) as TypedToolResult
  } catch {
    return undefined
  }
}

/**
 * Enrich an ExecuteResult's metadata with typed result info.
 * The output text is formatted to include the typed summary.
 */
function enrichExecuteResult(
  tool: string,
  result: Tool.ExecuteResult,
  typed: TypedToolResult,
): Tool.ExecuteResult {
  return {
    ...result,
    output: formatOutput(typed),
    metadata: {
      ...result.metadata,
      typedResult: typed,
      toolStatus: typed.status,
      toolErrorKind: typed.errorKind,
      toolRecoverable: typed.recoverable,
      suggestedNextTools: typed.suggestedNextTools,
    },
  }
}

// ─── Wrapping ─────────────────────────────────────────────────────────────────

/**
 * Wrap a tool execute Effect to produce a TypedToolResult-enriched result.
 *
 * Catches defects from the underlying execution (errors die'd by the
 * tool.ts pipeline) and converts them to structured typed results.
 * On success, enriches the result with status and affordances.
 */
export function wrapExecute(
  toolID: string,
  execute: Effect.Effect<Tool.ExecuteResult, never, any>,
): Effect.Effect<Tool.ExecuteResult, never, any> {
  return execute.pipe(
    Effect.catchDefect((defect: unknown) => {
      const typed = fromDefect(toolID, defect)
      return Effect.succeed({
        title: toolID,
        metadata: {
          typedResult: typed,
          toolStatus: typed.status,
          toolErrorKind: typed.errorKind,
          toolRecoverable: typed.recoverable,
          suggestedNextTools: typed.suggestedNextTools,
        },
        output: formatOutput(typed),
      } as Tool.ExecuteResult)
    }),
    Effect.map((result: Tool.ExecuteResult) => {
      const typed = makeSuccess(toolID, result.output, result.title || "Tool completed")
      return enrichExecuteResult(toolID, result, typed)
    }),
  )
}

/**
 * Wrap a Tool.Def so its execute function produces TypedToolResult-enriched
 * results. This is the primary integration point for the tool registry.
 */
export function wrapDef<P extends Schema.Decoder<unknown>, M extends Record<string, any>, R>(
  def: Tool.Def<P, M, R>,
): Tool.Def<P, M, R> {
  return {
    ...def,
    execute: ((args: any, ctx: any) =>
      wrapExecute(def.id, def.execute(args, ctx).pipe(Effect.orDie))) as Tool.Def<P, M, R>["execute"],
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface Interface {
  readonly wrap: <P extends Schema.Decoder<unknown>, M extends Record<string, any>, R>(
    def: Tool.Def<P, M, R>,
  ) => Tool.Def<P, M, R>
  readonly wrapExecute: (
    toolID: string,
    execute: Effect.Effect<Tool.ExecuteResult, never, any>,
  ) => Effect.Effect<Tool.ExecuteResult, never, any>
  readonly classifyError: (error: unknown) => { errorKind: string; recoverable: boolean; summary: string }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TypedResult") {}

export const layer: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({
    wrap: wrapDef,
    wrapExecute,
    classifyError,
  }),
)

export const defaultLayer = layer

// ─── PhaseGate integration ────────────────────────────────────────────────────

/**
 * Check if a tool is allowed by the current lifecycle phase and return
 * a typed result if blocked. Returns None if the tool is allowed or
 * if no PhaseGate is configured.
 */
export function checkPhaseGate(
  toolID: string,
): Effect.Effect<Option.Option<TypedToolResult>, never, any> {
  return (Effect.serviceOption(PhaseGate.Service) as Effect.Effect<Option.Option<any>, never, any>).pipe(
    Effect.flatMap((phaseGate: Option.Option<any>) => {
      if (Option.isNone(phaseGate)) return Effect.succeed(Option.none<TypedToolResult>()) as Effect.Effect<Option.Option<TypedToolResult>, never, any>
      return Effect.exit(phaseGate.value.checkAllowed(toolID)).pipe(
        Effect.map((exit: any) => {
          if (exit._tag === "Success") return Option.none<TypedToolResult>()
          const typed = fromDefect(toolID, exit.cause)
          return Option.some(typed)
        }),
      ) as Effect.Effect<Option.Option<TypedToolResult>, never, any>
    }),
  ) as Effect.Effect<Option.Option<TypedToolResult>, never, any>
}
