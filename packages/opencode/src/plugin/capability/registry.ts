import { Effect, Ref } from "effect"
import type { PluginSecurityState } from "./types"

type SecurityRegistry = Ref.Ref<Map<string, PluginSecurityState>>

export function make(): Effect.Effect<Registry, never, never> {
  return Effect.map(Ref.make(new Map<string, PluginSecurityState>()), (ref) => new Registry(ref))
}

export class Registry {
  constructor(private ref: Ref.Ref<Map<string, PluginSecurityState>>) {}

  register(pluginId: string, state: PluginSecurityState): Effect.Effect<void> {
    return Ref.update(this.ref, (map) => {
      const next = new Map(map)
      next.set(pluginId, state)
      return next
    })
  }

  get(pluginId: string): Effect.Effect<PluginSecurityState | undefined> {
    return Effect.map(Ref.get(this.ref), (map) => map.get(pluginId))
  }

  getAll(): Effect.Effect<Map<string, PluginSecurityState>> {
    return Ref.get(this.ref)
  }

  setCrashCount(pluginId: string, count: number): Effect.Effect<void> {
    return Ref.update(this.ref, (map) => {
      const existing = map.get(pluginId)
      if (!existing) return map
      const next = new Map(map)
      next.set(pluginId, { ...existing, crashCount: count })
      return next
    })
  }

  setQuarantined(pluginId: string, quarantined: boolean): Effect.Effect<void> {
    return Ref.update(this.ref, (map) => {
      const existing = map.get(pluginId)
      if (!existing) return map
      const next = new Map(map)
      next.set(pluginId, { ...existing, quarantined })
      return next
    })
  }
}
