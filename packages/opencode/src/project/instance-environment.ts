import { ConfigProvider, Layer } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { DatabaseAdapter } from "@/storage/adapter"
import { EventStore } from "@/event"
import { DuckDBConfig } from "@/storage/duckdb-config"
import { defaultLayer as BinaryManagerLayer } from "@/binary/manager"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { layer as AuthorityLayer } from "@/agent/authority"

// Compose dependent services as self-contained units before merging.
// Each unit resolves its internal dependencies via provideMerge,
// then all units merge concurrently (no cross-dependencies remain).

const configLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({}))

const dbAndEvents = EventStore.layer.pipe(
  Layer.provideMerge(DatabaseAdapter.LocalPgAdapter),
)

const flagsWithConfig = RuntimeFlags.defaultLayer.pipe(
  Layer.provideMerge(configLayer),
)

const duckWithConfig = DuckDBConfig.defaultLayer.pipe(
  Layer.provideMerge(configLayer),
)

const binaryWithFS = BinaryManagerLayer.pipe(
  Layer.provideMerge(AppFileSystem.defaultLayer),
)

export const layer = Layer.mergeAll(
  dbAndEvents,
  flagsWithConfig,
  duckWithConfig,
  binaryWithFS,
  AuthorityLayer,
)
export * as InstanceEnvironment from "./instance-environment"