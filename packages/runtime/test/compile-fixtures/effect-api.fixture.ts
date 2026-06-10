/**
 * Compile fixture: proves correct Effect 4.0.0-beta.66 API shapes.
 * This file MUST compile with `tsgo --noEmit`.
 * All migrations should match these patterns exactly.
 */
import { Effect, Context, Layer } from "effect"

// ============================================================
// OPTION A: Simple service — tag only, no class
// Best for services that don't need constructor state.
// ============================================================
interface MyServiceShape {
  readonly doThing: (input: number) => Effect.Effect<string>
}

const MyService = Context.Service<MyServiceShape>("MyService")

// yield* access
const _useService = Effect.gen(function* () {
  const { doThing } = yield* MyService
  return doThing(42)
})

// Layer.effect provides the service
const myServiceLayer = Layer.effect(
  MyService,
  Effect.gen(function* () {
    return MyService.of({
      doThing: (input) => Effect.succeed(`result: ${input}`),
    })
  })
)

// ============================================================
// OPTION B: Service class with constructor state
// The second arg to Context.Service<>()() is an options object.
// ============================================================
interface LoggerShape {
  readonly log: (msg: string) => Effect.Effect<void>
}
class LoggerService extends Context.Service<LoggerService, LoggerShape>()(
  "LoggerService",
  undefined
) {
  constructor(private readonly prefix: string) {
    // @ts-expect-error ServiceClass constructor inference limitation in beta.66
    super()
  }
  log(msg: string): Effect.Effect<void> {
    return Effect.log(`${this.prefix}: ${msg}`)
  }
}

const loggerLayer = Layer.effect(
  LoggerService,
  Effect.gen(function* () {
    return new LoggerService("[app]")
  })
)

const _useLogger = Effect.gen(function* () {
  const logger = yield* LoggerService
  return logger.log("hello")
})

// ============================================================
// Effect.gen — generator form returns Effect directly
// ============================================================
const genDirect = Effect.gen(function* () {
  yield* Effect.succeed(42)
  return "done" as const
})
const _genIsEffect: Effect.Effect<string> = genDirect

// Effect.fn
const fnNamed = Effect.fn("doWork")(function* (input: number) {
  yield* Effect.log(`processing ${input}`)
  return input * 2
})
const _fnResult: Effect.Effect<number> = fnNamed(21)
