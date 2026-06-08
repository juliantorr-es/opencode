import type { Component } from "solid-js"
import type {
  DesktopHostSlotMap,
  DesktopPluginApi,
  DesktopPluginModule,
} from "@tribunus/plugin/desktop"
import { createPluginTransport } from "./plugin-transport"

type SlotName = keyof DesktopHostSlotMap

interface PluginConfigEntry {
  name: string
  path: string
  enabled: boolean
  config?: Record<string, unknown>
}

/**
 * DesktopPluginLoader — renderer-native plugin loader for the Electron desktop.
 *
 * Reads plugin config from the IPC bridge (getDesktopPluginConfig), resolves
 * each plugin module via dynamic import(), and calls the plugin's `desktop()`
 * entrypoint with a properly scoped DesktopPluginApi.
 *
 * The loader must receive the provider's `registerSlot` function at construction
 * so that plugin slot registrations are wired into the shared slot registry.
 */
export class DesktopPluginLoader {
  private readonly slotUnregisters = new Map<SlotName, () => void>()
  private readonly disposeCallbacks: Array<() => void> = []
  private readonly loaded = new Set<string>()
  private configs: PluginConfigEntry[] = []
  private disposed = false

  constructor(
    private readonly registerSlot: (name: SlotName, component: Component<{}>) => () => void,
  ) {}

  private async ensureConfigs(): Promise<PluginConfigEntry[]> {
    if (this.configs.length === 0) {
      const result = (await window.api.getDesktopPluginConfig?.().catch(() => undefined)) ?? { configs: [] as PluginConfigEntry[], dropped: 0 }
      const configs = (result as any).configs ?? (result as any).value?.configs ?? []
      this.configs = configs
    }
    return this.configs
  }

  /**
   * Load a single plugin by name. Throws if not found in config.
   */
  async loadPlugin(name: string): Promise<void> {
    const configs = await this.ensureConfigs()
    const entry = configs.find((c) => c.name === name)
    if (!entry) throw new Error(`Plugin "${name}" not found in config`)
    if (!entry.enabled) return
    await this.loadEntry(entry)
  }

  /**
   * Load all enabled plugins in parallel.
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
   * Dispose all loaded plugins — calls onDispose callbacks and unregisters all
   * slot registrations.
   */
  dispose(): void {
    this.disposed = true
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

    if (this.disposed) return

    const mod: DesktopPluginModule = await import(/* @vite-ignore */ entry.path)
    if (!mod.desktop) return
    if (this.disposed) return

    const pluginStore = new Map<string, unknown>()

    const transport = createPluginTransport(entry.name)

    const api: DesktopPluginApi = {
      transport,
      slots: {
        register: (slotPlugin) => {
          if (this.disposed) return () => {}
          const unregisters: Array<() => void> = []
          for (const [name, component] of Object.entries(slotPlugin.slots)) {
            const unregister = this.registerSlot(name as SlotName, component as Component<{}>)
            this.slotUnregisters.set(name as SlotName, unregister)
            unregisters.push(unregister)
          }
          return () => {
            for (const unregister of unregisters) {
              unregister()
            }
          }
        },
      },
      store: {
        get: (key) => pluginStore.get(key),
        set: (key, value) => {
          if (!this.disposed) pluginStore.set(key, value)
        },
      },
      lifecycle: {
        onDispose: (fn) => {
          if (!this.disposed) this.disposeCallbacks.push(fn)
        },
      },
    }

    // Register transport cleanup on plugin dispose
    api.lifecycle.onDispose(() => transport.destroy())

    if (this.disposed) {
      transport.destroy()
      return
    }
    await mod.desktop(api)
  }
}
