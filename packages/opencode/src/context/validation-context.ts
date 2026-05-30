import { Context, Effect, Layer, Ref } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"

// ── Normalized Test Failure ──────────────────────────────

export interface NormalizedTestFailure {
  testName: string
  file: string
  line?: number
  message: string
  sessionId: string
  timestamp: string
}

// ── Interface ────────────────────────────────────────────

export interface Interface {
  readonly getFailures: () => Effect.Effect<NormalizedTestFailure[]>
  readonly setFailures: (failures: NormalizedTestFailure[]) => Effect.Effect<void>
  readonly addFailure: (failure: NormalizedTestFailure) => Effect.Effect<void>
  readonly clear: () => Effect.Effect<void>
}

// ── Service ──────────────────────────────────────────────

export class Service extends Context.Service<Service, Interface>()("@opencode/ValidationContext") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make<NormalizedTestFailure[]>([])

    const getFailures: Interface["getFailures"] = () => Ref.get(state)

    const setFailures: Interface["setFailures"] = (failures) => Ref.set(state, failures)

    const addFailure: Interface["addFailure"] = (failure) =>
      Ref.update(state, (f) => [...f, failure])

    const clear: Interface["clear"] = () => Ref.set(state, [])

    return Service.of({ getFailures, setFailures, addFailure, clear })
  }),
)

export const defaultLayer = layer
