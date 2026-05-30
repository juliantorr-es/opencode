import { Effect } from "effect"
import type { CapabilityId, PluginSecurityState, CapabilityManifest } from "./types"
import { Registry } from "./registry"

/**
 * Default capabilities granted to external plugins without a manifest.
 * Legacy-safe: grants tool registration and UI slots, denies sensitive capabilities.
 */
export const FALLBACK_MANIFEST: CapabilityManifest = {
  capabilities: ["tool.register"],
}

/**
 * Check if a plugin has a specific capability.
 *
 * - If plugin is quarantined, all capabilities are denied.
 * - If trust level is "built-in", all capabilities are auto-allowed.
 * - Otherwise, checks the plugin's manifest capabilities list.
 */
export function checkCapability(
  registry: Registry,
  pluginId: string,
  requiredCapability: CapabilityId,
): Effect.Effect<boolean> {
  return Effect.flatMap(registry.get(pluginId), (state) => {
    if (!state) return Effect.succeed(false)
    if (state.quarantined) return Effect.succeed(false)
    if (state.trustLevel === "built-in") return Effect.succeed(true)
    return Effect.succeed(state.manifest.capabilities.includes(requiredCapability))
  })
}

export function makeFallbackState(trustLevel: PluginSecurityState["trustLevel"]): PluginSecurityState {
  return {
    trustLevel,
    manifest: FALLBACK_MANIFEST,
    crashCount: 0,
    quarantined: false,
  }
}
