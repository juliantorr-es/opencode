import { Duration, Effect, Option, Schedule, Schema, Semaphore } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"
import * as ToolCache from "./cache"

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

      // Layer 4: Per-tool semaphore for maxConcurrency control
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

        // Layer 1: Core pipeline — decode, execute, truncate (unchanged logic)
        const core: Effect.Effect<ExecuteResult<M>, any, any> = Effect.gen(function* () {
          const decoded = yield* decode(args).pipe(
            Effect.mapError(
              (error) =>
                new InvalidArgumentsError({
                  tool: id,
                  detail: toolInfo.formatValidationError ? toolInfo.formatValidationError(error) : String(error),
                }),
            ),
          )
          const result = yield* execute(decoded as Schema.Schema.Type<Parameters>, ctx)
          if (result.metadata.truncated !== undefined) {
            return result
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
          }
        })

        // Compose pipeline inside-out using explicit any-erased type
        let pipeline: Effect.Effect<any, any, any> = core as any

        // Layer 2: Retry with exponential backoff if retry is configured
        if (toolInfo.retry !== undefined) {
          const { times, backoff } = toolInfo.retry
          pipeline = pipeline.pipe(
            Effect.retry({ times, schedule: Schedule.exponential(backoff) }),
          )
        }

        // Layer 3: Timeout envelope via Effect.timeoutOption
        if (toolInfo.timeout !== undefined) {
          const timeoutDuration = Duration.fromInputUnsafe(toolInfo.timeout)
          const durationMs = Duration.toMillis(timeoutDuration)
          pipeline = pipeline.pipe(
            Effect.timeoutOption(timeoutDuration),
            Effect.flatMap((option) => {
              if (Option.isNone(option)) {
                return Effect.fail(
                  new TimeoutError({ tool: id, detail: "Tool execution timed out", durationMs }),
                )
              }
              return Effect.succeed(option.value)
            }),
          )
        }

        // Layer 4: Per-tool semaphore (wraps after retry + timeout)
        if (semaphore !== undefined) {
          pipeline = semaphore.withPermits(1)(pipeline)
        }

        // Layer 5: Enriched span attributes
        const orDied: Effect.Effect<ExecuteResult<M>> = Effect.orDie(
          pipeline as Effect.Effect<ExecuteResult<M>, any, any>,
        ) as any
        return (orDied as any).pipe(
          Effect.withSpan("Tool.execute", { attributes: attrs }),
          Effect.annotateCurrentSpan({
            "tool.cacheable": String(toolInfo.cacheable !== undefined),
            ...(toolInfo.maxConcurrency !== undefined
              ? { "tool.max_concurrency": toolInfo.maxConcurrency }
              : {}),
            ...(toolInfo.timeout !== undefined
              ? { "tool.timeout_ms": Duration.toMillis(Duration.fromInputUnsafe(toolInfo.timeout)) }
              : {}),
          }),
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
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}

export * as Tool from "./tool"
