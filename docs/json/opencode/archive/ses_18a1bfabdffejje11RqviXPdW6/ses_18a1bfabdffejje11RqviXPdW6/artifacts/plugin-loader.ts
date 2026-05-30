import type { Component } from "solid-js"

// --- Types matching the desktop plugin contract ---

type DesktopHostSlotMap = {
  window_titlebar: {}
  window_titlebar_left: {}
  sidebar_content: {}
  sidebar_footer: {}
}

type SlotName = keyof DesktopHostSlotMap

interface PluginConfigEntry {
  name: string
  path: string
  enabled: boolean
  config?: Record<string, unknown>
}

interface DesktopPluginApi {
  slots: {
    register(name: SlotName, component: Component<{}>): () => void
  }
  store: {
    get(key: string): unknown
    set(key: string, value: unknown): void
  }
  lifecycle: {
    onDispose(fn: () => void): void
  }
}

interface DesktopPluginModule {
  id?: string
  desktop: (api: DesktopPluginApi) => Promise<void> | void
}

// --- DesktopPluginLoader ---

/**
 * Loads desktop plugins from IPC-provided config using dynamic import().
 *
 * Each plugin receives a DesktopPluginApi with slot registration, a scoped
 * in-memory store, and lifecycle hooks. Call `dispose()` to clean up all
 * registered callbacks and slot registrations.
 */
export class DesktopPluginLoader {
  private readonly slotUnregisters = new Map<SlotName, () => void>()
  private readonly disposeCallbacks: Array<() => void> = []
  private readonly loaded = new Set<string>()
  private configs: PluginConfigEntry[] = []

  private async ensureConfigs(): Promise<PluginConfigEntry[]> {
    if (this.configs.length === 0) {
      this.configs = (await window.api.getDesktopPluginConfig?.()) ?? []
    }
    return this.configs
  }

  /**
   * Load a single plugin by name from the plugin config.
   * Throws if the named plugin is not found in the config.
   */
  async loadPlugin(name: string): Promise<void> {
    const configs = await this.ensureConfigs()
    const entry = configs.find((c) => c.name === name)
    if (!entry) throw new Error(`Plugin "${name}" not found in config`)
    if (!entry.enabled) return
    await this.loadEntry(entry)
  }

  /**
   * Load all enabled plugins from the plugin config.
   * Plugins are loaded in parallel.
   */
  async loadAll(): Promise<void> {
    const configs = await this.ensureConfigs()
    await Promise.all(
      configs
        .filter((c) => c.enabled)
        .map((entry) => this.loadEntry(entry)),
    )
  }

  /**
   * Dispose all loaded plugins. Calls every registered onDispose callback,
   * unregisters all slot registrations, and resets internal state.
   */
  dispose(): void {
    for (const cb of this.disposeCallbacks) {
      cb()
    }
    this.disposeCallbacks.length = 0

    for (const unregister of this.slotUnregisters.values()) {
      unregister()
    }
    this.slotUnregisters.clear()
    this.loaded.clear()
    this.configs = []
  }

  private async loadEntry(entry: PluginConfigEntry): Promise<void> {
    if (this.loaded.has(entry.name)) return
    this.loaded.add(entry.name)

    const mod: DesktopPluginModule = await import(entry.path)
    if (!mod.desktop) return

    const pluginStore = new Map<string, unknown>()

    const api: DesktopPluginApi = {
      slots: {
        register: (name, component) => {
          // Unregister any existing slot at this position first
          const existing = this.slotUnregisters.get(name)
          existing?.()

          const unregister = () => {
            this.slotUnregisters.delete(name)
          }
          this.slotUnregisters.set(name, unregister)
          return unregister
        },
      },
      store: {
        get: (key) => pluginStore.get(key),
        set: (key, value) => {
          pluginStore.set(key, value)
        },
      },
      lifecycle: {
        onDispose: (fn) => {
          this.disposeCallbacks.push(fn)
        },
      },
    }

    await mod.desktop(api)
  }
}
