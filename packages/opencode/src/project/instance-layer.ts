import { Effect, Layer, ConfigProvider } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { layer as InstanceHealthStoreLayer } from "./instance-health"
import { InstanceStore } from "./instance-store"
import { InstanceTrace } from "./instance-trace"
import { InstanceRuntime } from "./instance-runtime"
import { InstanceBootstrap } from "./bootstrap"
import { DatabaseAdapter } from "@/storage/adapter"
import { EventStore } from "@/event"

export const layer = Layer.unwrap(
  Effect.sync(() => {
    // EventStoreLayer requires DatabaseAdapter — chain so dependency builds first
    const dbAndEvents = EventStore.layer.pipe(
      Layer.provideMerge(DatabaseAdapter.LocalPgAdapter),
    )
    // InstanceRuntime requires EventStore + DatabaseAdapter — chain on top of dbAndEvents
    const runtimeWithDB = InstanceRuntime.layer.pipe(
      Layer.provideMerge(dbAndEvents),
    )
    const providers = Layer.mergeAll(
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      InstanceBootstrap.defaultLayer,
      InstanceHealthStoreLayer,
      runtimeWithDB,
      RuntimeFlags.defaultLayer,
    )
    return Layer.provideMerge(
      Layer.mergeAll(
        InstanceStore.defaultLayer,
        InstanceTrace.layer,
      ),
      providers,
    )
  }),
)

export * as InstanceLayer from "./instance-layer"
