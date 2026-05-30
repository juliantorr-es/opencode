/**
 * Scoped in-memory key-value store for desktop plugins.
 *
 * Each instance is bound to a single pluginId and prefixes all keys with
 * `plugin:<id>:` so that no plugin can read or write another plugin's data
 * or the host's store keys. The backing store is a plain Map (session-only;
 * no localStorage or electron-store).
 */

export class ScopedPluginStore {
  private store: Map<string, unknown>
  private prefix: string

  constructor(pluginId: string) {
    this.store = new Map()
    this.prefix = `plugin:${pluginId}:`
  }

  /** Retrieve the value stored under a scoped key, or undefined if absent. */
  get(key: string): unknown {
    return this.store.get(this.prefixed(key))
  }

  /** Persist a value under a scoped key. */
  set(key: string, value: unknown): void {
    this.store.set(this.prefixed(key), value)
  }

  /** Remove the entry for a scoped key. Returns true if the key existed. */
  delete(key: string): boolean {
    return this.store.delete(this.prefixed(key))
  }

  /** Return all scoped keys (prefix stripped) currently held by this plugin. */
  keys(): string[] {
    const result: string[] = []
    for (const k of this.store.keys()) {
      if (k.startsWith(this.prefix)) {
        result.push(k.slice(this.prefix.length))
      }
    }
    return result
  }

  /** Remove every scoped key held by this plugin. */
  clear(): void {
    for (const k of this.store.keys()) {
      if (k.startsWith(this.prefix)) {
        this.store.delete(k)
      }
    }
  }

  // ── private helpers ──────────────────────────────────────────────────

  private prefixed(key: string): string {
    return `${this.prefix}${key}`
  }
}
