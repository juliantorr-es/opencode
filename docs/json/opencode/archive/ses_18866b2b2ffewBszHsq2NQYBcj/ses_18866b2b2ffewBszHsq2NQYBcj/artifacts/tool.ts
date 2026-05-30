import { Duration, Effect, Option, Schedule, Schema, Semaphore } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import * as ToolCache from "./cache"
import { Agent } from "@/agent/agent"

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

/**
 * Base tagged error for ALL recoverable tool errors. Every tool error
 * extends this, making it matchable upstream in the session / execution
 * bridge. The `orDie` boundary in wrap() converts unknown errors to
 * defects — but ToolError and its subtypes survive and are catchable.
 */
export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ToolError", {
  tool: Schema.String,
  detail: Schema.String,
}) {}

/**
 * Raised when a tool execution exceeds its configured timeout.
 */
export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("TimeoutError", {
  tool: Schema.String,
  detail: Schema.String,
  duration: Schema.String,
}) {
  override get message() {
    return `[${this.tool}] Timed out after ${this.duration}: ${this.detail}`
  }
}

/**
 * Raised when a transient condition prevents execution (e.g. network
 * blip, resource contention). The retry layer catches TransientError
 * and retries with exponential backoff.
 */
export class TransientError extends Schema.TaggedErrorClass<TransientError>()("TransientError", {
  tool: Schema.String,
  detail: Schema.String,
}) {}

/**
 * Raised when the LLM provides valid schema-matching arguments that are
 * still semantically invalid (e.g. file path outside workspace, regex
 * syntax error after schema passes). This is distinct from schema-level
 * InvalidArgumentsError.
 */
export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
  tool: Schema.String,
  detail: Schema.String,
}) {}

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
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>, never, R>
  formatValidationError?(error: unknown): string
  cacheable?: boolean | { ttl?: Duration.Input; maxSize?: number }
  timeout?: Duration.Input
  retry?: { times: number; backoff: Duration.Input; onError?: Array<new (...args: any[]) => Error> }
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
  R = any,
> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M, R>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata, R = any> =
  | DefWithoutID<Parameters, M, R>
  | (() => Effect.Effect<DefWithoutID<Parameters, M, R>>)

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

const MAX_OUTPUT_BYTES = 1 * 1024 * 1024 // 1 MB hard limit before truncation

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata, R = any>(
  id: string,
  init: Init<Parameters, Result, R>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
  cache: ToolCache.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      const execute = toolInfo.execute

      // Per-tool semaphore for maxConcurrency (lazy — created only if set)
      let concurrencySemaphore: Semaphore.Semaphore | undefined
      if (toolInfo.maxConcurrency != null && toolInfo.maxConcurrency > 0) {
        concurrencySemaphore = yield* Semaphore.make(toolInfo.maxConcurrency)
      }

      // Resolve retry config with defaults
      const retryConfig = toolInfo.retry
      const timeoutDuration: Duration.Input = toolInfo.timeout ?? "30 seconds"

      toolInfo.execute = (args, ctx): Effect.Effect<ExecuteResult<Result>, never, R> => {
        const attrs: Record<string, any> = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }

        // Layer 1 — core execution: decode → execute → truncate
        let effect = Effect.gen(function* () {
          const decoded = yield* decode(args).pipe(
            Effect.mapError(
              (error) =>
                new InvalidArgumentsError({
                  tool: id,
                  detail: toolInfo.formatValidationError ? toolInfo.formatValidationError(error) : String(error),
                }),
            ),
          )
          const isCacheable = Boolean(toolInfo.cacheable)
          let result: ExecuteResult<Result>
          if (isCacheable && cache) {
            const key = `${id}:${JSON.stringify(decoded)}`
            result = yield* cache.getOrCompute(key, () => execute(decoded as Schema.Schema.Type<Parameters>, ctx)) as any
          } else {
            result = yield* execute(decoded as Schema.Schema.Type<Parameters>, ctx) as any
            if (cache) yield* cache.invalidate()
            yield* Effect.annotateCurrentSpan({ "cache.hit": false })
          }

          // Memory limit: hard cap on output size before truncation
          const outputSize = Buffer.byteLength(result.output, "utf-8")
          if (outputSize > MAX_OUTPUT_BYTES) {
            result = {
              ...result,
              output: result.output.slice(0, MAX_OUTPUT_BYTES),
              metadata: { ...result.metadata, outputTruncated: true },
            }
          }

          // Truncation (head/tail limit — already handles line & byte caps)
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agentInfo = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agentInfo)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        })

        // Layer 2 — retry with exponential backoff (only for transient errors)
        if (retryConfig) {
          const times = retryConfig.times ?? 3
          const backoff = retryConfig.backoff ?? "500 millis"
          const errorMatchers = [
            (error: unknown) => error instanceof TransientError,
            ...(retryConfig.onError ?? []).map(
              (ErrType) => (error: unknown) => error instanceof ErrType,
            ),
          ]
          effect = effect.pipe(
            Effect.retry({
              while: (error) => errorMatchers.some((match) => match(error)),
              schedule: Schedule.exponential(backoff).pipe(Schedule.recurs(times)),
            }),
          )
        }

        // Layer 3 — timeout: Option.none → structured timeout result
        effect = effect.pipe(
          Effect.timeoutOption(timeoutDuration),
          Effect.flatMap((option) => {
            if (Option.isNone(option)) {
              return Effect.succeed({
                title: id,
                metadata: { status: "timeout" },
                output: `[${id}] Tool execution timed out after ${String(timeoutDuration)}. Try a simpler request or split the work.`,
              } as ExecuteResult<Result>)
            }
            return Effect.succeed(option.value)
          }),
        )

        // Layer 4 — per-tool concurrency limit
        if (concurrencySemaphore) {
          effect = concurrencySemaphore.withPermit(effect)
        }

        // Layer 5 — span & safety net
        return effect.pipe(
          Effect.orDie,
          Effect.withSpan("Tool.execute", { attributes: attrs }),
        ) as any
      }
      return toolInfo
    })
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<any, any, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = (yield* init) as DefWithoutID<Parameters, Result>
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      const cache = yield* ToolCache.Service
      return { id, init: wrap(id, resolved, truncate, agents, cache) }
    }),
    { id },
  ) as any
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata, R = any>(
  info: Info<P, M, R>,
): Effect.Effect<Def<P, M, R>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}

export * as Tool from "./tool"
