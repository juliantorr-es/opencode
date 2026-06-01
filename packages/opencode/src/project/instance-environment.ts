import { ConfigProvider, Layer } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { DatabaseAdapter } from "@/storage/adapter"
import { EventStore } from "@/event"
import { DuckDBConfig } from "@/storage/duckdb-config"
import { defaultLayer as BinaryManagerLayer } from "@/binary/manager"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { layer as AuthorityLayer } from "@/agent/authority"
import { defaultLayer as ScratchpadLayer } from "@/agent/scratchpad"

// Core instance infrastructure — services required by instance-owned forked fibers.
// Composed as self-contained units so no cross-dependencies remain at merge time.

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
  ScratchpadLayer,
)

export * as InstanceEnvironment from "./instance-environment"