import { Effect, Layer, ConfigProvider } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { layer as InstanceHealthStoreLayer } from "./instance-health"
import { InstanceStore } from "./instance-store"
import { InstanceTrace } from "./instance-trace"

export const layer = Layer.unwrap(
  Effect.promise(async () => {
    const { InstanceBootstrap } = await import("./bootstrap")
    const providers = Layer.mergeAll(
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      InstanceBootstrap.defaultLayer,
      InstanceHealthStoreLayer,
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
