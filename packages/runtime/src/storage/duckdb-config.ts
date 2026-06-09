import { Config, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

export class Service extends ConfigService.Service<Service>()("@tribunus/DuckDBConfig", {
  dbPath: Config.string("OPENCODE_DUCKDB_PATH").pipe(Config.option),
}) {}

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export * as DuckDBConfig from "./duckdb-config"
