import { Duration, Effect, Option, Schedule, Schema, Semaphore } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"
import * as ToolCache from "./cache"
import * as CacheKey from "./cache-key"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import {
  getRecoveryState,
  CapabilityContext,
  type PrivilegeBoundary,
  type ApprovalLevel,
  CapabilityRefusalError,
} from "@/capability/metadata"
import { evaluateCapabilityAuthority } from "@/capability/authority"
import { persistAuthorityReceipt } from "@/capability/receipts"
import { CapabilityToolRegistry, CapabilityToolRegistryError, type CapabilityToolDefinition } from "@/capability/tool-registry"
import { SessionTable } from "@/storage/schema"
import { eq } from "@/storage/db"
import * as Database from "@/storage/db"
import { one } from "@/storage/adapter"

interface Metadata {
  [key: string]: any
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

/**
 * Raised when the LLM calls a tool with arguments that fail the parameter
 * schema. This is the canonical "rewrite the input" tool error: the typed
 * error class makes it matchable upstream, and its `message` getter produces
 * the model-facing prose that the AI SDK feeds back as the tool result.
 */
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()(
  "ToolInvalidArgumentsError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
  }
}

export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ToolError", {
  tool: Schema.String,
  detail: Schema.String,
  recoverable: Schema.Boolean,
}) {
  override get message() {
    return `[${this.tool}] ${this.detail}`
  }
}

export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("TimeoutError", {
  tool: Schema.String,
  detail: Schema.String,
  durationMs: Schema.Number,
}) {
  override get message() {
    return `Tool "${this.tool}" timed out after ${this.durationMs}ms: ${this.detail}`
  }
}

export class TransientError extends Schema.TaggedErrorClass<TransientError>()("TransientError", {
  tool: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `[${this.tool}] Transient error: ${this.detail}. Retrying may help.`
  }
}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
  tool: Schema.String,
  detail: Schema.String,
  field: Schema.String,
}) {
  override get message() {
    return `[${this.tool}] Validation error on field "${this.field}": ${this.detail}`
  }
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
  R = any,
> {
  id: string
  description: string
  parameters: Parameters
  jsonSchema?: JSONSchema7
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context<M>): Effect.Effect<ExecuteResult<M>, never, R>
  formatValidationError?(error: unknown): string
  cacheable?: boolean | { ttl?: Duration.Input; maxSize?: number }
  timeout?: Duration.Input
  retry?: { times: number; backoff: Duration.Input; onError?: Array<{ error: new (...args: any[]) => Error }> }
  maxConcurrency?: number
  errorTaxonomy?: { recoverable?: boolean; userActionable?: boolean }
}
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
  R = any,
> = Omit<Def<Parameters, M, R>, "id">

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

function makeConservativeToolDefinition(id: string, toolInfo: { description?: string; jsonSchema?: JSONSchema7 } & Record<string, any>): CapabilityToolDefinition {
  const description = toolInfo.description || `Execute tool ${id}`
  const sourceType = toolInfo.sourceType === "mcp" ? "mcp" : toolInfo.sourceType ?? "native"
  const providerID = toolInfo.providerID ?? "opencode.native"

  return {
    toolID: id,
    capabilityID: `tool.execute:${id}`,
    sourceType,
    providerID,
    displayName: toolInfo.displayName ?? id,
    description,
    metadata: {
      id: `tool.execute:${id}`,
      description,
      privilegeBoundaries: ["unknown"],
      mutationClass: "side-effect",
      determinismClass: "external",
      approvalLevel: "human",
      blockedRecoveryStates: [
        "coordination_unavailable",
        "coordination_rebuilding",
        "coordination_degraded",
        "coordination_refused",
      ],
    },
    receiptBehavior: "authority-receipt",
    importStatus: "conservative",
    inputSchema: toolInfo.jsonSchema,
  }
}

export type InferParameters<T> =
  T extends Info<infer P, any>
    ? Schema.Schema.Type<P>
    : T extends Effect.Effect<Info<infer P, any>, any, any>
      ? Schema.Schema.Type<P>
      : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

function wrap<Parameters extends Schema.Decoder<unknown>, M extends Metadata>(
  id: string,
  init: Init<Parameters, M>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      const execute = toolInfo.execute

      // Per-tool semaphore for maxConcurrency control
      let semaphore: Semaphore.Semaphore | undefined
      if (toolInfo.maxConcurrency !== undefined && toolInfo.maxConcurrency > 0) {
        semaphore = yield* Semaphore.make(toolInfo.maxConcurrency)
      }

      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }

        const startTime = Date.now()

        // Pipeline ordering rationale:
        //
        // 1. Decode first — malformed input must fail before any side effects.
        // 2. Cache wrapping (with retry only on compute) — cache hit avoids work;
        //    retry applies to raw execution only, not cache lookup.
        //    Truncation runs inside cache so truncated output IS cached.
        // 3. Timeout after cache — timeout counts compute time, not semaphore wait.
        // 4. Semaphore outermost among execution gates — concurrency limit includes
        //    timeout, so queued calls don't race the clock.
        // 5. Telemetry as non-fatal tap — failures caught and logged, never propagated.
        // 6. Normalize as tapDefect — defects are tagged for attribution only, not
        //    converted to typed errors (that happens at the registry/typed-result layer).
        // 7. Span annotation last — the span records the final outcome including all
        //    upstream processing.

        const governed = Effect.gen(function* () {
          const registryOpt = yield* Effect.serviceOption(CapabilityToolRegistry)
          let toolDef: CapabilityToolDefinition | undefined

          if (Option.isSome(registryOpt)) {
            const registry = registryOpt.value
            const resolved = yield* registry.resolveCapabilityTool(id).pipe(
              Effect.catchIf(
                (error) => error instanceof CapabilityToolRegistryError && error.reason === "tool_not_found",
                () => Effect.succeed(undefined),
              ),
            )
            toolDef = resolved
          }

          if (toolDef === undefined) {
            toolDef = makeConservativeToolDefinition(id, toolInfo as any)
          }

          const dynamicMetadata = toolDef.metadata

          let projectID: string | undefined = undefined
          try {
            const row: any = yield* Effect.promise(() =>
              Database.use((db) =>
                one(
                  db
                    .select({ project_id: SessionTable.project_id })
                    .from(SessionTable)
                    .where(eq(SessionTable.id, ctx.sessionID))
                )
              )
            )
            projectID = row?.project_id
          } catch (e) {
            // Nullable fallback
          }

          const recoveryState = yield* getRecoveryState(ctx.sessionID, dynamicMetadata.mutationClass)
          const capCtx = yield* Effect.serviceOption(CapabilityContext)
          const grantedBoundaries = Option.isSome(capCtx)
            ? capCtx.value.grantedBoundaries
            : ((ctx.extra?.grantedBoundaries as PrivilegeBoundary[]) ?? ["shell"])
          const approvalLevelGranted = Option.isSome(capCtx)
            ? capCtx.value.approvalLevelGranted
            : ((ctx.extra?.approvalLevelGranted as ApprovalLevel) ?? "auto")
          const authorityGrants = Option.isSome(capCtx)
            ? capCtx.value.authorityGrants
            : undefined

          const capResult = evaluateCapabilityAuthority({
            metadata: dynamicMetadata,
            recoveryState,
            grantedBoundaries,
            approvalLevelGranted,
            availableAuthorityGrants: authorityGrants,
          })

          const extendedChain = [
            {
              toolID: toolDef.toolID,
              providerID: toolDef.providerID,
              sourceType: toolDef.sourceType,
              importStatus: toolDef.importStatus,
            },
            ...(capResult.authorityChain ?? []),
          ]

          yield* persistAuthorityReceipt({
            capabilityId: dynamicMetadata.id,
            actionName: `tool.execute:${id}`,
            sessionId: ctx.sessionID,
            projectId: projectID,
            authorityOutcome: capResult.available ? "allowed" : "refused",
            refusalReasons: capResult.reasons,
            authorityChain: extendedChain,
            missingAuthority: capResult.missingAuthority,
            recoveryState,
            approvalLevel: dynamicMetadata.approvalLevel,
            privilegeBoundaries: [...dynamicMetadata.privilegeBoundaries],
            consentClass: capResult.consentClass,
          })

          if (!capResult.available) {
            const reason = capResult.reasons[0] as any
            return yield* Effect.fail(
              new CapabilityRefusalError({
                reason: reason || "human_approval_required",
                message: capResult.message || `Capability tool.execute:${id} refused`,
              })
            )
          }
        })

        // ── Stage 1: Decode tool arguments ──
        const decoded = Effect.flatMap(governed, () =>
          decodeToolArgs(decode, id, toolInfo.formatValidationError)(args)
        )

        // ── Stage 2: Execute with cache + truncation (retry wraps compute only) ──
        const executed = Effect.flatMap(decoded, (params) =>
          executeWithCache(id, execute as any, { cacheable: toolInfo.cacheable, retry: toolInfo.retry } as any, params as Schema.Schema.Type<Parameters>, ctx, truncate, agents),
        )

        // ── Stage 3: Apply timeout ──
        const timed = applyTimeout(executed as any, toolInfo.timeout as any, id)

        // ── Stage 4: Apply concurrency (semaphore wraps entire execution) ──
        const concurrent = applyConcurrency(timed, semaphore)

        // ── Stage 5: Telemetry taps (non-fatal) ──
        const telemetered = recordToolTelemetry(concurrent, id, ctx, startTime)

        // ── Stage 6: Normalize tool errors (defect tap only — no orDie) ──
        const normalized = normalizeToolError(telemetered)

        // ── Stage 7: Span annotation ──
        return annotateToolSpan(normalized, attrs, {
          cacheable: toolInfo.cacheable,
          maxConcurrency: toolInfo.maxConcurrency,
          timeout: toolInfo.timeout as any,
        }) as any
      }
      return toolInfo
    })
}

// ═══════════════════════════════════════════════════════════
// Named pipeline stages — independently testable
// ═══════════════════════════════════════════════════════════

/** Stage 1: Decode raw LLM arguments through the tool's parameter schema. */
function decodeToolArgs(
  decode: ReturnType<typeof Schema.decodeUnknownEffect>,
  id: string,
  formatValidationError?: (error: unknown) => string,
): (args: unknown) => Effect.Effect<unknown, InvalidArgumentsError, any> {
  return (args: unknown) =>
    decode(args).pipe(
      Effect.mapError(
        (error) =>
          new InvalidArgumentsError({
            tool: id,
            detail: formatValidationError ? formatValidationError(error) : String(error),
          }),
      ),
    )
}

/**
 * Stage 2: Cache-aware tool execution with truncation.
 *
 * - If cache is available and the tool is cacheable, uses `getOrCompute`.
 * - Otherwise runs `execute` directly.
 * - Retry (when configured) is applied to the compute function only, not
 *   to the cache lookup or truncation steps.
 * - After execution, output is truncated via the truncation service.
 */
function executeWithCache<Parameters, M extends Metadata>(
  id: string,
  execute: (params: Parameters, ctx: Context<M>) => Effect.Effect<M, any, any>,
  toolInfo: {
    cacheable?: boolean | { ttl?: string; maxSize?: number }
    retry?: { times: number; backoff: number | Duration.Duration }
  },
  params: Parameters,
  ctx: Context<M>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
): Effect.Effect<ExecuteResult<M>, ToolError | ValidationError | TransientError> {
  return Effect.gen(function* () {
    const cache = yield* Effect.serviceOption(ToolCache.Service)

    // Compute function with optional retry wrapping only the execute call
    const compute = (): Effect.Effect<M, any> => {
      const raw = execute(params, ctx) as any
      if (toolInfo.retry !== undefined) {
        const { times, backoff } = toolInfo.retry
        return (raw as any).pipe(Effect.retry({ times, schedule: Schedule.exponential(backoff as any) })) as any
      }
      return raw
    }

    let result: any
    if (Option.isNone(cache) || !toolInfo.cacheable) {
      yield* Effect.annotateCurrentSpan({
        "cache.available": Option.isNone(cache) ? "false" : "true",
      }).pipe(Effect.catchCause(() => Effect.void))
      result = yield* compute()
    } else {
      yield* Effect.annotateCurrentSpan({ "cache.available": "true" }).pipe(
        Effect.catchCause(() => Effect.void),
      )
      const cacheConfig =
        typeof toolInfo.cacheable === "object" ? toolInfo.cacheable : {}
      const key = yield* Effect.promise(() =>
        CacheKey.derive({
          toolID: id,
          args: params,
          sessionID: ctx.sessionID,
          agent: ctx.agent,
        }),
      )
      result = yield* cache.value.getOrCompute(key as any, compute as any, {
        ttl: cacheConfig.ttl
          ? Duration.fromInputUnsafe(cacheConfig.ttl as any)
          : undefined,
        maxEntrySize: cacheConfig.maxSize,
      })
    }

    // Truncation: skip if already truncated upstream
    if (result.metadata?.truncated !== undefined) {
      return result as ExecuteResult<M>
    }
    const agent = yield* agents.get(ctx.agent)
    const truncated = yield* truncate.output(result.output, {}, agent)
    return {
      ...result,
      output: truncated.content,
      metadata: {
        ...result.metadata,
        truncated: truncated.truncated,
        ...(truncated.truncated && { outputPath: truncated.outputPath }),
      },
    } as ExecuteResult<M>
  }) as any
}

/** Stage 3: Apply a timeout envelope around the effect. */
function applyTimeout<A, E>(
  effect: Effect.Effect<A, E>,
  timeout?: number | string | Duration.Duration,
  id?: string,
): Effect.Effect<A, E | TimeoutError> {
  if (timeout === undefined) return effect as any
  const timeoutDuration = Duration.fromInputUnsafe(timeout as any)
  const durationMs = Duration.toMillis(timeoutDuration)
  return (effect as any).pipe(
    Effect.timeoutOption(timeoutDuration),
    Effect.flatMap((option: Option.Option<A>) => {
      if (Option.isNone(option)) {
        return Effect.fail(
          new TimeoutError({
            tool: id ?? "unknown",
            detail: "Tool execution timed out",
            durationMs,
          }),
        )
      }
      return Effect.succeed(option.value)
    }),
  ) as any
}

/** Stage 4: Gate execution through a semaphore for concurrency control. */
function applyConcurrency<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  semaphore?: Semaphore.Semaphore,
): Effect.Effect<A, E, R> {
  if (semaphore === undefined) return effect
  return semaphore.withPermits(1)(effect)
}

/** Stage 5: Non-fatal telemetry taps — failures are caught and logged, never propagated. */
function recordToolTelemetry<A, E>(
  effect: Effect.Effect<A, E>,
  id: string,
  ctx: Context,
  startTime: number,
): Effect.Effect<A, E> {
  return (effect as any).pipe(
    Effect.tap((result: any) =>
      Effect.serviceOption(AppFileSystem.Service).pipe(
        Effect.flatMap((fsOpt: Option.Option<any>) =>
          Option.match(fsOpt, {
            onNone: () => Effect.void,
            onSome: (fs: any) =>
              Effect.gen(function* () {
                const instance = yield* InstanceState.context as any
                const elapsed = Date.now() - startTime
                const isTruncated = result?.metadata?.truncated === true
                const record = JSON.stringify({
                  ts: new Date().toISOString(),
                  tool: id,
                  sessionID: ctx.sessionID,
                  callID: ctx.callID,
                  elapsed_ms: elapsed,
                  truncated: isTruncated,
                  instanceID: instance.instanceID,
                })
                const logDir = path.join(
                  instance.directory,
                  "docs", "json", "opencode",
                  "sessions", ctx.sessionID, "analytics",
                )
                yield* fs.ensureDir(logDir) as any
                yield* fs.appendLine(
                  path.join(logDir, "tool_invocations.v1.jsonl"),
                  record,
                ) as any
              }).pipe(
                Effect.catch((err: any) =>
                  Effect.logWarning("Tool telemetry write failed", {
                    tool: id,
                    sessionID: ctx.sessionID,
                    error: String(err),
                  }),
                ),
              ),
          }),
        ),
      ),
    ),
    Effect.tapError((error: unknown) =>
      Effect.serviceOption(AppFileSystem.Service).pipe(
        Effect.flatMap((fsOpt: Option.Option<any>) =>
          Option.match(fsOpt, {
            onNone: () => Effect.void,
            onSome: (fs: any) =>
              Effect.gen(function* () {
                const elapsed = Date.now() - startTime
                const errorTag =
                  (error as any)?._tag ??
                  (error as any)?.constructor?.name ??
                  "unknown"
                const errorDetail =
                  error instanceof Error ? error.message : String(error)
                const instance = yield* InstanceState.context as any
                const record = JSON.stringify({
                  ts: new Date().toISOString(),
                  tool: id,
                  sessionID: ctx.sessionID,
                  callID: ctx.callID,
                  elapsed_ms: elapsed,
                  error_tag: errorTag,
                  error_detail: errorDetail.slice(0, 200),
                })
                const logDir = path.join(
                  instance.directory,
                  "docs", "json", "opencode",
                  "sessions", ctx.sessionID, "analytics",
                )
                yield* fs.ensureDir(logDir) as any
                yield* fs.appendLine(
                  path.join(logDir, "tool_errors.v1.jsonl"),
                  record,
                ) as any
                if (errorTag === "unknown" || errorTag === "UnknownError") {
                  yield* Effect.logWarning("UnknownError in tool invocation", {
                    tool: id,
                    sessionID: ctx.sessionID,
                    error_tag: errorTag,
                    error_detail: errorDetail.slice(0, 200),
                  })
                }
              }).pipe(
                Effect.catch((err: any) =>
                  Effect.logWarning("Tool telemetry write failed", {
                    tool: id,
                    sessionID: ctx.sessionID,
                    error: String(err),
                  }),
                ),
              ),
          }),
        ),
      ),
    ),
  ) as any
}

function normalizeToolError<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
  return (effect as any).pipe(
    Effect.tapDefect((defect: unknown) =>
      Effect.annotateCurrentSpan({
        "tool.defect": true,
        "tool.defect_type": String(defect),
      }),
    ),
  ) as any
}

/** Stage 7: Wrap with OpenTelemetry span and annotate with tool metadata. */
function annotateToolSpan<A, E>(
  effect: Effect.Effect<A, E>,
  attrs: Record<string, string>,
  toolInfo: {
    cacheable?: unknown
    maxConcurrency?: number
    timeout?: number | string | Duration.Duration
  },
): Effect.Effect<A, E> {
  const spanAnnotations: Record<string, unknown> = {
    "tool.cacheable": String(toolInfo.cacheable !== undefined),
    ...(toolInfo.maxConcurrency !== undefined
      ? { "tool.max_concurrency": toolInfo.maxConcurrency }
      : {}),
    ...(toolInfo.timeout !== undefined
      ? {
          "tool.timeout_ms": Duration.toMillis(
            Duration.fromInputUnsafe(toolInfo.timeout as any),
          ),
        }
      : {}),
  }
  return (effect as any).pipe(
    Effect.withSpan("Tool.execute", { attributes: attrs }),
    Effect.tap(() => Effect.annotateCurrentSpan(spanAnnotations)),
  ) as any
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    const init = yield* info.init()
    const raw = init.execute
    return {
      ...init,
      id: info.id,
      // Wrap execute so tool dependencies captured at construction time
      // are available when the tool runs in a different fiber later.
      execute: (args, ctx) => raw(args, ctx).pipe(Effect.provideContext(context)),
    } as Def<P, M>
  })
}

export * as Tool from "./tool"
