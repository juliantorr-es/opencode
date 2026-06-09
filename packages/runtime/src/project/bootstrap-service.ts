import { Context, Effect } from "effect"

export interface BootstrapResult {
  readonly status: "ready" | "degraded" | "failed"
  readonly failedServices: Array<string>
}

export interface Interface {
  readonly run: Effect.Effect<BootstrapResult>
}

export class Service extends Context.Service<Service, Interface>()("@tribunus/InstanceBootstrap") {}

export * as InstanceBootstrap from "./bootstrap-service"
