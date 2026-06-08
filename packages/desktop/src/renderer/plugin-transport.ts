/**
 * PluginTransport — abstract communication layer for desktop plugins.
 *
 * Two implementations:
 *   - ElectronPluginTransport — wraps the preload bridge (window.api.*)
 *   - NoopTransport           — silent fallback when no transport is available
 *
 * BrowserPluginTransport (BroadcastChannel) is deferred — see DC-002 for
 * web-based plugin loading.
 *
 * Channel names are automatically prefixed with the plugin name to prevent
 * cross-plugin collisions on the wire.
 */

import type { PluginTransport } from "@tribunus/plugin/desktop"

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a PluginTransport for the current environment.
 *
 * In Electron: wraps window.api.pluginSend/pluginOn/pluginOff/pluginInvoke.
 * In other environments: returns a safe noop transport.
 */
export function createPluginTransport(pluginName: string): PluginTransport {
  const api = (window as any).api
  if (api?.pluginSend) {
    return createElectronPluginTransport(pluginName, api)
  }
  return createNoopTransport()
}

// ---------------------------------------------------------------------------
// Electron renderer transport — wraps window.api.* (preload bridge)
// ---------------------------------------------------------------------------

interface ElectronApiTransport {
  pluginSend(channel: string, data?: unknown): void
  pluginOn(channel: string, handler: (data: unknown) => void): () => void
  pluginOff(channel: string, handler: (data: unknown) => void): void
  pluginInvoke(channel: string, data?: unknown): Promise<unknown>
}

/**
 * Creates a PluginTransport backed by the preload bridge (window.api).
 *
 * Channel names are prefixed with the plugin name to prevent collisions:
 *   plugin "my-plugin" sending on "config-change" → wire channel "my-plugin:config-change"
 */
function createElectronPluginTransport(
  pluginName: string,
  api: ElectronApiTransport,
): PluginTransport {
  const prefix = `${pluginName}:`
  const activeSubscriptions = new Set<() => void>()

  return {
    send(channel: string, data?: unknown): void {
      try {
        api.pluginSend(prefix + channel, data)
      } catch (e) {
        console.error(`[plugin-transport] ${pluginName} send error on "${channel}":`, e)
      }
    },

    async invoke(channel: string, data?: unknown): Promise<unknown> {
      try {
        return await api.pluginInvoke(prefix + channel, data)
      } catch (e) {
        console.error(`[plugin-transport] ${pluginName} invoke error on "${channel}":`, e)
        throw e
      }
    },

    on(channel: string, handler: (data: unknown) => void): () => void {
      const unsub = api.pluginOn(prefix + channel, handler)
      const cleanup = () => {
        unsub()
        activeSubscriptions.delete(cleanup)
      }
      activeSubscriptions.add(cleanup)
      return cleanup
    },

    off(channel: string, handler: (data: unknown) => void): void {
      api.pluginOff(prefix + channel, handler)
    },

    destroy(): void {
      for (const unsub of activeSubscriptions) {
        unsub()
      }
      activeSubscriptions.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Noop transport — safe fallback
// ---------------------------------------------------------------------------

function createNoopTransport(): PluginTransport {
  return {
    send(): void {
      /* noop */
    },
    async invoke(): Promise<unknown> {
      return undefined
    },
    on(): () => void {
      return () => {}
    },
    off(): void {
      /* noop */
    },
    destroy(): void {
      /* noop */
    },
  }
}
