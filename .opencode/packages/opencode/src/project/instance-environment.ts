import { ConfigProvider, Layer } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { DatabaseAdapter } from "@/storage/adapter"
import { EventStore } from "@/event"
import { DuckDBConfig } from "@/storage/duckdb-config"
import { defaultLayer as BinaryManagerLayer } from "@/binary/manager"

// EventStore requires DatabaseAdapter — compose them first
const dbAndEvents = EventStore.layer.pipe(
  Layer.provideMerge(DatabaseAdapter.LocalPgAdapter),
)

// RuntimeFlags and DuckDBConfig require ConfigProvider — compose with it
const configLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({}))
const flagsWithConfig = RuntimeFlags.defaultLayer.pipe(
  Layer.provideMerge(configLayer),
)
const duckWithConfig = DuckDBConfig.defaultLayer.pipe(
  Layer.provideMerge(configLayer),
)

const binaryManager = BinaryManagerLayer

// Now merge all the self-contained groups. Each group has no remaining requirements.
// mergeAll builds concurrently, but the groups have no cross-dependencies.
export const layer = Layer.mergeAll(
  dbAndEvents,
  flagsWithConfig,
  duckWithConfig,
  binaryManager,
)

export * as InstanceEnvironment from "./instance-environment"
