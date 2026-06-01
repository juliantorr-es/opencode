import { ConfigProvider, Layer } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { DatabaseAdapter } from "@/storage/adapter"
import { EventStore } from "@/event"
import { DuckDBConfig } from "@/storage/duckdb-config"

export const layer = Layer.mergeAll(
  ConfigProvider.layer(ConfigProvider.fromUnknown({})),
  RuntimeFlags.defaultLayer,
).pipe(
  Layer.provideMerge(DatabaseAdapter.LocalPgAdapter),
  Layer.provideMerge(EventStore.layer),
  Layer.provideMerge(DuckDBConfig.defaultLayer),
)

export * as InstanceEnvironment from "./instance-environment"
