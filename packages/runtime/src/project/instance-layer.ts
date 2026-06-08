import { Effect, Layer } from "effect"
import { layer as InstanceHealthStoreLayer } from "./instance-health"
import { InstanceStore } from "./instance-store"
import { InstanceTrace } from "./instance-trace"
import { InstanceEnvironment } from "./instance-environment"

export const layer = InstanceEnvironment.layer.pipe(
  Layer.provideMerge(
    Layer.unwrap(
      Effect.promise(async () => {
        const [{ InstanceBootstrap }, { InstanceRuntime }] = await Promise.all([
          import("./bootstrap"),
          import("./instance-runtime"),
        ])
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
  ),
)

export * as InstanceLayer from "./instance-layer"