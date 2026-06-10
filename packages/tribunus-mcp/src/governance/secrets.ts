/**
 * Secrets Provider — unified secret resolution with pluggable backends.
 *
 * Order: env vars first (fast, no deps), then database backends (lazy).
 * Secrets are NEVER logged, serialized to receipts, or exported to subprocess env.
 * Use `secrets.get("KEY")` instead of `process.env.KEY`.
 */

export interface SecretsBackend {
  readonly name: string
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
}

// ── Env Var Backend ────────────────────────────────────────────────────────

class EnvSecretsBackend implements SecretsBackend {
  readonly name = "env"

  async get(key: string): Promise<string | undefined> {
    return process.env[key] || undefined
  }

  async set(key: string, value: string): Promise<void> {
    process.env[key] = value
  }

  async delete(key: string): Promise<void> {
    delete process.env[key]
  }

  async list(): Promise<string[]> {
    // Only list known secret key prefixes, never dump all env vars
    const knownPrefixes = ["GITHUB_", "HF_", "TRIBUNUS_", "MACMON", "OPENCODE_"]
    return Object.keys(process.env).filter((k) =>
      knownPrefixes.some((p) => k.startsWith(p)),
    )
  }
}

// ── PGlite Backend ─────────────────────────────────────────────────────────

class PgliteSecretsBackend implements SecretsBackend {
  readonly name = "pglite"
  private db: unknown = null

  private async ensureTable(): Promise<void> {
    if (this.db) return
    try {
      // Dynamic import via Function() to avoid static TS module resolution
      const PGliteMod = await Function('return import("@electric-sql/pglite")')() as { PGlite: new (dir: string) => { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } }
      const { resolve } = await import("node:path") as { resolve: (...p: string[]) => string }
      const { getStoreDir } = await import("./store.js")
      const dir = getStoreDir()
      const db = new PGliteMod.PGlite(dir)
      await db.query(
        "CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW())",
      )
      this.db = db
    } catch (e) {
      throw new Error(
        `PGlite secrets backend unavailable: ${e instanceof Error ? e.message : String(e)}. Install @electric-sql/pglite or use env vars.`,
      )
    }
  }

  async get(key: string): Promise<string | undefined> {
    await this.ensureTable()
    const db = this.db as { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
    const result = await db.query("SELECT value FROM secrets WHERE key = $1", [key])
    return result.rows[0]?.value as string | undefined
  }

  async set(key: string, value: string): Promise<void> {
    await this.ensureTable()
    const db = this.db as { query: (sql: string, params?: unknown[]) => Promise<unknown> }
    await db.query(
      "INSERT INTO secrets (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
      [key, value],
    )
  }

  async delete(key: string): Promise<void> {
    await this.ensureTable()
    const db = this.db as { query: (sql: string, params?: unknown[]) => Promise<unknown> }
    await db.query("DELETE FROM secrets WHERE key = $1", [key])
  }

  async list(): Promise<string[]> {
    await this.ensureTable()
    const db = this.db as { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> }
    const result = await db.query("SELECT key FROM secrets ORDER BY key")
    return result.rows.map((r) => r.key as string)
  }
}

// ── Unified Provider ───────────────────────────────────────────────────────

class SecretsProvider {
  private backends: SecretsBackend[]

  constructor(backends: SecretsBackend[]) {
    this.backends = backends
  }

  /** Try each backend in order; return first non-undefined value. */
  async get(key: string): Promise<string | undefined> {
    for (const backend of this.backends) {
      try {
        const value = await backend.get(key)
        if (value !== undefined) return value
      } catch {
        // Backend unavailable — skip to next
      }
    }
    return undefined
  }

  /** Require a secret; throws if not found in any backend. */
  async require(key: string): Promise<string> {
    const value = await this.get(key)
    if (value === undefined) {
      throw new Error(
        `Secret "${key}" not found in any backend (${this.backends.map((b) => b.name).join(", ")}). Set it via env var or PGlite.`,
      )
    }
    return value
  }

  async set(key: string, value: string): Promise<void> {
    // Write to the first writable backend (env is always writable)
    for (const backend of this.backends) {
      try {
        await backend.set(key, value)
        return
      } catch {
        // Skip unwritable backends
      }
    }
  }

  async delete(key: string): Promise<void> {
    for (const backend of this.backends) {
      try {
        await backend.delete(key)
      } catch {}
    }
  }

  async list(): Promise<string[]> {
    const keys = new Set<string>()
    for (const backend of this.backends) {
      try {
        for (const k of await backend.list()) keys.add(k)
      } catch {}
    }
    return Array.from(keys).sort()
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

const backends: SecretsBackend[] = [new EnvSecretsBackend()]

// Add PGlite backend if enabled via TRIBUNUS_SECRETS_BACKEND=pglite
if (process.env.TRIBUNUS_SECRETS_BACKEND === "pglite") {
  backends.push(new PgliteSecretsBackend())
}

export const secrets = new SecretsProvider(backends)

// ═══════════════════════════════════════════════════════════════════════════
// Secret keys — canonical names used across all domains
// ═══════════════════════════════════════════════════════════════════════════

export const SECRET_KEYS = {
  GITHUB_APP_ID: "GITHUB_APP_ID",
  GITHUB_APP_INSTALLATION_ID: "GITHUB_APP_INSTALLATION_ID",
  GITHUB_APP_PRIVATE_KEY: "GITHUB_APP_PRIVATE_KEY",
  GITHUB_APP_PRIVATE_KEY_PATH: "GITHUB_APP_PRIVATE_KEY_PATH",
  HF_TOKEN: "HF_TOKEN",
  TRIBUNUS_CAPABILITIES: "TRIBUNUS_CAPABILITIES",
  TRIBUNUS_COMPUTE_DIR: "TRIBUNUS_COMPUTE_DIR",
  TRIBUNUS_EVIDENCE_DB: "TRIBUNUS_EVIDENCE_DB",
  TRIBUNUS_MLX_MODEL_DIR: "TRIBUNUS_MLX_MODEL_DIR",
  TRIBUNUS_ALLOW_DIRTY_BUILD: "TRIBUNUS_ALLOW_DIRTY_BUILD",
  MACMON_URL: "MACMON_URL",
} as const
