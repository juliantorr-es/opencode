import { Effect, Layer } from "effect"
import { layer as InstanceHealthStoreLayer } from "./instance-health"
import { InstanceStore } from "./instance-store"
import { InstanceTrace } from "./instance-trace"

export const layer = Layer.unwrap(
  Effect.promise(async () => {
    const { InstanceBootstrap } = await import("./bootstrap")
    return InstanceStore.defaultLayer.pipe(
      Layer.provide(InstanceBootstrap.defaultLayer),
      Layer.provide(InstanceTrace.layer),
      Layer.provide(InstanceHealthStoreLayer),
    )
  }),
)

export * as InstanceLayer from "./instance-layer"
