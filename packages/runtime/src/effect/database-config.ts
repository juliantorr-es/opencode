import { Config, Context, Layer, Option, Redacted } from "effect"
import { ConfigService } from "@/effect/config-service"

export class Service extends ConfigService.Service<Service>()("@tribunus/DatabaseConfig", {
  url: Config.redacted("OPENCODE_DATABASE_URL").pipe(Config.option),
  ssl: Config.boolean("OPENCODE_DATABASE_SSL").pipe(Config.withDefault(true)),
  poolSize: Config.number("OPENCODE_DATABASE_POOL_SIZE").pipe(Config.withDefault(10)),
}) {}

/** Convenience: the resolved URL string, or `undefined` if no PG config is set. */
export const resolvedUrl = (config: Context.Service.Shape<typeof Service>): string | undefined =>
  Option.match(config.url, { onNone: () => undefined, onSome: (r) => Redacted.value(r) })

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export * as DatabaseConfig from "./database-config"
