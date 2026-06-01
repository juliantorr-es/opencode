import { Context, Effect, Layer, Option } from "effect"

export class Service extends Context.Tag("BinaryManager/Service")<
  Service,
  {
    /**
     * Resolve a binary name to its absolute path using system PATH.
     */
    readonly which: (name: string) => Effect.Effect<Option.Option<string>>
  }
>() {}

export const defaultLayer = Layer.succeed(
  Service,
  Service.of({
    which: (name) =>
      Effect.sync(() => {
        const result = Bun.which(name)
        return result ? Option.some(result) : Option.none()
      }),
  }),
)
