import { Effect } from "effect"
import { CapabilityId, isValidCapabilityId } from "./types"
import { HOOK_CAPABILITY_MAP, ALWAYS_ALLOWED_HOOKS } from "./hook-map"
import { checkCapability } from "./enforcer"
import { Registry } from "./registry"

/**
 * Hooks that pass potentially sensitive data to the plugin handler.
 * These require the network.request capability to prevent data exfiltration
 * via network calls from the plugin's hook handler.
 */
const NETWORK_GATED_HOOKS = new Set([
  "event",
  "chat.message",
  "chat.params",
  "chat.headers",
  "shell.env",
  "command.execute.before",
  "tool.execute.before",
  "tool.execute.after",
  "tool.definition",
  "permission.ask",
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
  "experimental.compaction.autocontinue",
  "experimental.text.complete",
])

/**
 * Guards hook dispatch by checking plugin capabilities.
 * Sits between the event bus / trigger function and the plugin hook handler.
 *
 * For each hook dispatch:
 * 1. Always-allowed hooks (dispose, config, auth, provider) bypass all checks
 * 2. Unknown hooks are denied by default
 * 3. Hook-specific capability from HOOK_CAPABILITY_MAP is checked
 * 4. Network-gated hooks additionally require network.request
 */
export class HookDispatchGuard {
  constructor(private registry: Registry) {}

  /**
   * Check whether a hook dispatch should proceed for the given plugin.
   */
  shouldDispatch(hookName: string, pluginId: string): Effect.Effect<boolean> {
    if (ALWAYS_ALLOWED_HOOKS.has(hookName)) return Effect.succeed(true)

    const requiredCapability = HOOK_CAPABILITY_MAP[hookName]
    if (!requiredCapability) return Effect.succeed(false)

    if (!isValidCapabilityId(requiredCapability)) {
      return Effect.succeed(false)
    }

    const registry = this.registry
    return Effect.gen(function* () {
      const hasHookCapability = yield* checkCapability(registry, pluginId, requiredCapability)
      if (!hasHookCapability) return false
      if (NETWORK_GATED_HOOKS.has(hookName)) {
        return yield* checkCapability(registry, pluginId, CapabilityId.NetworkRequest)
      }
      return true
    })
  }
}

export function makeHookDispatchGuard(registry: Registry): HookDispatchGuard {
  return new HookDispatchGuard(registry)
}
