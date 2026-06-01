import { Effect, Layer, Stream, Scope } from "effect"
import { Bus } from "../bus"
import { EventStore } from "."
import * as Log from "@opencode-ai/core/util/log"
import type { RuntimeEvent } from "./runtime-event"
import { EventName } from "./event-names"

const log = Log.create({ service: "event-bridge" })

/**
 * Infer the actor category from a bus event type string.
 */
function inferActor(eventType: string): RuntimeEvent["actor"] {
  if (eventType.startsWith("session.") || eventType.startsWith("server.") || eventType.startsWith("instance."))
    return "lifecycle"
  if (eventType.startsWith("question.") || eventType.startsWith("permission."))
    return "user"
  if (eventType.startsWith("tool.") || eventType.startsWith("command.") || eventType.startsWith("file."))
    return "tool"
  if (eventType.startsWith("llm.") || eventType.startsWith("agent.") || eventType.startsWith("session.next"))
    return "assistant"
  return "system"
}

function extractSessionId(properties: Record<string, unknown>): string {
  const id = (properties as any).sessionID ?? (properties as any).session_id ?? ""
  return String(id)
}

function extractToolName(properties: Record<string, unknown>): string | undefined {
  return (properties as any).toolName ?? (properties as any).tool_name ?? (properties as any).name
}

function extractStatus(properties: Record<string, unknown>): RuntimeEvent["status"] | undefined {
  const phase = (properties as any).phase ?? (properties as any).status ?? (properties as any).toolStatus
  if (phase && typeof phase === "string") {
    const lowered = phase.toLowerCase()
    if (
      lowered === "started" ||
      lowered === "succeeded" ||
      lowered === "failed" ||
      lowered === "denied" ||
      lowered === "cancelled" ||
      lowered === "recovered"
    ) {
      return lowered as RuntimeEvent["status"]
    }
  }
  return undefined
}

function toRuntimeEvent(payload: { id: string; type: string; properties: Record<string, unknown> }): RuntimeEvent {
  const props = payload.properties ?? {}
  return {
    id: payload.id,
    sessionId: extractSessionId(props),
    runId: extractSessionId(props),
    parentEventId: undefined,
    correlationId: undefined,
    ts: new Date().toISOString(),
    actor: inferActor(payload.type),
    eventType: payload.type as EventName,
    phase: (props as any).phase as string | undefined,
    status: extractStatus(props),
    toolName: extractToolName(props),
    filePath: (props as any).filePath ?? (props as any).file_path,
    model: (props as any).model,
    durationMs: (props as any).durationMs ?? (props as any).duration_ms,
    tokenInput: (props as any).tokenInput ?? (props as any).token_input,
    tokenOutput: (props as any).tokenOutput ?? (props as any).token_output,
    errorCode: (props as any).errorCode ?? (props as any).error_code,
    errorMessage: (props as any).errorMessage ?? (props as any).error_message,
    recoverable: (props as any).recoverable as boolean | undefined,
    payloadJson: props,
  }
}

/**
 * Layer that subscribes to all bus events and records them in the EventStore.
 * Uses effectDiscard to create a Layer<never> from an effect with no service tag.
 */
export const layer: Layer.Layer<never, never, Bus.Service | EventStore.Service> = Layer.effectDiscard(
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* EventStore.Service

      log.info("starting event bridge — subscribing to all bus events")

      const stream = yield* bus.subscribeAll()
      yield* stream.pipe(
        Stream.map((payload) => {
          const event = toRuntimeEvent(payload as any)
          log.debug("bridging event", { type: event.eventType, id: event.id })
          return event
        }),
        Stream.runForEach((event) => store.record(event).pipe(Effect.ignore)),
        Effect.forkScoped,
      )

      log.info("event bridge fiber started")
    }),
  ),
)
