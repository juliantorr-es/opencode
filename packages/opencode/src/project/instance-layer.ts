import { Layer } from "effect"
import { layer as InstanceHealthStoreLayer } from "./instance-health"
import { InstanceStore } from "./instance-store"
import { InstanceTrace } from "./instance-trace"
import { InstanceEnvironment } from "./instance-environment"

export const layer = InstanceEnvironment.layer.pipe(
  Layer.provideMerge(
    Layer.suspend(() => {
      const { InstanceBootstrap } = require("./bootstrap") as typeof import("./bootstrap")
      const { InstanceRuntime } = require("./instance-runtime") as typeof import("./instance-runtime")
      const runtimeWithEnv = InstanceRuntime.layer.pipe(
        Layer.provideMerge(InstanceEnvironment.layer),
      )
      const providers = Layer.mergeAll(
        runtimeWithEnv,
        InstanceBootstrap.defaultLayer,
        InstanceHealthStoreLayer,
      )
      return Layer.provideMerge(
        Layer.mergeAll(
          InstanceStore.defaultLayer,
          InstanceTrace.layer,
        ),
        providers,
      )
    }),
  ),
)

export * as InstanceLayer from "./instance-layer"