import { ConfigProvider, Layer } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { DatabaseAdapter } from "@/storage/adapter"
import { EventStore } from "@/event"
import { DuckDBConfig } from "@/storage/duckdb-config"
import { defaultLayer as BinaryManagerLayer } from "@/binary/manager"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { layer as AuthorityLayer } from "@/agent/authority"
import { defaultLayer as ScratchpadLayer } from "@/agent/scratchpad"
import { defaultLayer as ProjectMapLayer } from "@/context/project-map"
import { defaultLayer as BusLayer } from "@/bus"
import { defaultLayer as ContextInvalidationBusLayer } from "@/context/invalidation-bus"

// ─── Service Boundary ──────────────────────────────────────────────────────────
// Core instance infrastructure — services required by instance-owned forked fibers.
// Composed as self-contained units so no cross-dependencies remain at merge time.
//
// Core infrastructure (bottom of stack, no external deps beyond ambient Scope):
//   DatabaseAdapter, EventStore — database and event recording
//   RuntimeFlags              — feature-flag evaluation
//   DuckDBConfig              — analytical DB configuration
//   BinaryManager             — binary tool lifecycle
//   AppFileSystem             — virtual filesystem abstraction
//   ConfigProvider            — empty config backbone
//
// Instance-scoped domain services (self-contained, no cross-service deps):
//   Authority                 — tool/filesystem permission contracts
//   Scratchpad                — agent working memory (per-fiber Ref)
//   Bus                       — typed per-instance PubSub event bus
//     → Bus.layer uses InstanceState.make (Scope.Scope only, ambient)
//   ProjectMap                — workspace package resolution
//     → requires AppFileSystem + Bus, both baked in via Layer.provide in project-map.ts
//   ContextInvalidationBus    — context cache invalidation broadcaster
//
// All sub-layers are standalone: no service in this merge leaks a requirement
// that another sub-layer must satisfy. Duplicate service tags (Bus appears
// directly and baked into ProjectMap; AppFileSystem appears in binaryWithFS and
// baked into ProjectMap) are deduplicated by Layer.mergeAll.

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
  BusLayer,
  ProjectMapLayer,
  ContextInvalidationBusLayer,
)

export * as InstanceEnvironment from "./instance-environment"