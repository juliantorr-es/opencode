import type { CapabilityId } from "./types"

/**
 * Maps each plugin hook name to its required capability.
 * Hooks not listed here are either always-allowed (dispose, config, auth, provider)
 * or unknown (denied by default).
 */
export const HOOK_CAPABILITY_MAP: Record<string, CapabilityId> = {
  tool: "tool.register",
  event: "event.subscribe",
  "chat.message": "hooks.transform_message",
  "chat.params": "hooks.transform_message",
  "chat.headers": "hooks.transform_message",
  "permission.ask": "hooks.transform_message",
  "command.execute.before": "hooks.transform_message",
  "tool.execute.before": "tool.execute",
  "tool.execute.after": "tool.execute",
  "shell.env": "secrets.access",
  "experimental.chat.messages.transform": "hooks.transform_message",
  "experimental.chat.system.transform": "hooks.transform_system",
  "experimental.session.compacting": "hooks.compaction",
  compaction: "hooks.compaction",
}

/**
 * Hook names that bypass capability checks entirely.
 * These are always allowed for all plugins (auth, provider, lifecycle hooks).
 */
export const ALWAYS_ALLOWED_HOOKS = new Set([
  "dispose",
  "config",
  "auth",
  "provider",
])
