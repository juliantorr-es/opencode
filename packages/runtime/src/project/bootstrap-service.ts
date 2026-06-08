import { Context, Effect } from "effect"

export interface BootstrapResult {
  readonly status: "ready" | "degraded" | "failed"
  readonly failedServices: Array<string>
}

export interface Interface {
  readonly run: Effect.Effect<BootstrapResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceBootstrap") {}

export * as InstanceBootstrap from "./bootstrap-service"
