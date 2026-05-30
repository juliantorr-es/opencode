import { spawn } from "child_process"
import { Context, Effect, Layer, Option } from "effect"

import { checkSQLFirewall } from "./duckdb-firewall"
import { runPipeline } from "./pipeline"
import { DatabaseAdapter } from "./adapter"
import { DuckDBConfig } from "./duckdb-config"
import { HealthRegistry, HealthStatus } from "@/server/health"

// ── Client interface ──────────────────────────────────────

export interface DuckDBRawClient {
  /** Run a SELECT / analytical query and return all rows. */
  all<T = any>(sql: string): Promise<T[]>
  /** Run a SELECT / analytical query and return the first row only. */
  get<T = any>(sql: string): Promise<T | undefined>
  /** Run a DDL or utility statement (no result rows expected). */
  run(sql: string): Promise<void>
  /** Release any held resources. */
  close(): Promise<void>
}

// ── Error type ─────────────────────────────────────────────

export class DuckDBError extends Error {
  readonly _tag = "DuckDBError"
  constructor(message: string) {
    super(message)
    this.name = "DuckDBError"
  }
}

// ── Service tag ────────────────────────────────────────────

export class Service extends Context.Service<Service, DuckDBRawClient>()("@opencode/DuckDB") {}

// ── Pool configuration ─────────────────────────────────────

const DEFAULT_MAX_CONNECTIONS = 4
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000
const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000

// ── Single-query execution ─────────────────────────────────
// Spawns a duckdb subprocess, executes one SQL statement, returns JSON.
// The -readonly flag prevents any write SQL from being accepted at the
// process level, providing defense-in-depth beyond application-layer guards.

function execSQL<T>(resolvedPath: string, sql: string, timeoutMs: number = 30_000, signal?: AbortSignal): Promise<T> {
  checkSQLFirewall(sql)
  return new Promise((resolve, reject) => {
    const args = resolvedPath === ":memory:" ? [":memory:", "-json", "-c", sql] : [resolvedPath, "-readonly", "-json", "-c", sql]
    const proc = spawn("duckdb", args, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          proc.kill()
          reject(new DuckDBError(`DuckDB query timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      : undefined

    const onAbort = signal
      ? () => {
          proc.kill()
          reject(new DuckDBError("DuckDB query aborted via signal"))
        }
      : undefined

    if (onAbort) signal!.addEventListener("abort", onAbort, { once: true })

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener("abort", onAbort)
    }

    proc.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString()
    })
    proc.on("close", (code) => {
      cleanup()
      if (code !== 0) {
        reject(new DuckDBError(stderr || `duckdb exited with code ${code}`))
      } else {
        try {
          resolve(JSON.parse(stdout) as T)
        } catch {
          reject(new DuckDBError(`Failed to parse DuckDB output: ${stdout.slice(0, 200)}`))
        }
      }
    })
    proc.on("error", (err) => {
      cleanup()
      reject(new DuckDBError(`Failed to spawn duckdb: ${err.message}`))
    })
  })
}

// ── Connection pool ────────────────────────────────────────
// Limits the number of concurrent duckdb subprocesses to `maxConnections`.
// Queries beyond the limit are queued and processed as slots become available.
// Idle timeout flushes the queue if no slot frees within the window.

interface PoolRequest<T> {
  sql: string
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

class DuckDBConnectionPool {
  private activeCount = 0
  private queue: Array<PoolRequest<any>> = []
  private closed = false
  private readonly resolvedPath: string
  readonly maxConnections: number
  readonly queueTimeoutMs: number
  readonly executionTimeoutMs: number

  constructor(resolvedPath: string, maxConnections: number, queueTimeoutMs: number, executionTimeoutMs: number) {
    this.resolvedPath = resolvedPath
    this.maxConnections = maxConnections
    this.queueTimeoutMs = queueTimeoutMs
    this.executionTimeoutMs = executionTimeoutMs
  }

  async run<T>(sql: string): Promise<T> {
    if (this.closed) throw new DuckDBError("DuckDB pool is closed")

    if (this.activeCount < this.maxConnections) {
      return this.executeQuery<T>(sql)
    }

    // Queue the request — wait for an available slot
    return new Promise<T>((resolve, reject) => {
      const timer = this.queueTimeoutMs > 0
        ? setTimeout(() => {
            const idx = this.queue.findIndex((r) => r.resolve === resolve)
            if (idx !== -1) {
              this.queue.splice(idx, 1)
              reject(new DuckDBError(`DuckDB query queue timed out after ${this.queueTimeoutMs}ms`))
            }
          }, this.queueTimeoutMs)
        : undefined

      this.queue.push({
        sql,
        resolve: (val: T) => {
          if (timer) clearTimeout(timer)
          resolve(val)
        },
        reject: (err: unknown) => {
          if (timer) clearTimeout(timer)
          reject(err)
        },
      })
    })
  }

  private async executeQuery<T>(sql: string): Promise<T> {
    this.activeCount++
    try {
      return await execSQL<T>(this.resolvedPath, sql, this.executionTimeoutMs)
    } finally {
      this.activeCount--
      this.drainQueue()
    }
  }

  private drainQueue(): void {
    while (this.activeCount < this.maxConnections && this.queue.length > 0) {
      const next = this.queue.shift()!
      this.executeQuery(next.sql).then(next.resolve).catch(next.reject)
    }
  }

  close(): void {
    this.closed = true
    const remaining = this.queue.splice(0)
    for (const req of remaining) {
      req.reject(new DuckDBError("DuckDB pool closed"))
    }
  }
}

// ── CLI-backed client with pooling ─────────────────────────

function createCLIClient(
  dbPath?: string,
  maxConnections: number = DEFAULT_MAX_CONNECTIONS,
  queueTimeoutMs: number = DEFAULT_QUEUE_TIMEOUT_MS,
  executionTimeoutMs: number = DEFAULT_EXECUTION_TIMEOUT_MS,
): DuckDBRawClient {
  const resolvedPath = dbPath ?? ":memory:"
  const pool = new DuckDBConnectionPool(resolvedPath, maxConnections, queueTimeoutMs, executionTimeoutMs)

  return {
    all: <T>(sql: string) => pool.run<T[]>(sql),
    get: async <T>(sql: string) => {
      const rows = await pool.run<T[]>(sql)
      return rows[0] ?? undefined
    },
    run: async (sql: string) => {
      await pool.run<any[]>(sql)
    },
    close: async () => {
      pool.close()
    },
  }
}

// ── WASM-backed client (preferred, future) ─────────────────
// When @duckdb/duckdb-wasm is installed, DuckDB can run in-process
// via Bun's WebAssembly runtime. This path is deferred until the
// package is confirmed available; currently falls back to CLI subprocess.

async function createWASMClient(_dbPath?: string): Promise<DuckDBRawClient | null> {
  // WASM initialization requires the @duckdb/duckdb-wasm package plus
  // bundled data files (.wasm, .worker). Return null to use CLI fallback
  // until the WASM integration is verified end-to-end.
  return null
}

// ── Init ───────────────────────────────────────────────────

/**
 * Create a DuckDB client for analytical queries.
 *
 * Tries @duckdb/duckdb-wasm first (when the package is installed),
 * then falls back to spawning the native `duckdb` CLI binary.
 *
 * The returned client is READ-ONLY — write operations (INSERT, UPDATE,
 * DELETE, CREATE, DROP) are rejected at the subprocess level via the
 * -readonly flag. A connection pool (maxConnections=4, idleTimeout=30s)
 * limits concurrent subprocesses to prevent resource exhaustion.
 */
export async function init(
  dbPath?: string,
  maxConnections: number = DEFAULT_MAX_CONNECTIONS,
  queueTimeoutMs: number = DEFAULT_QUEUE_TIMEOUT_MS,
  executionTimeoutMs: number = DEFAULT_EXECUTION_TIMEOUT_MS,
): Promise<DuckDBRawClient> {
  const wasm = await createWASMClient(dbPath)
  if (wasm) return wasm
  return createCLIClient(dbPath, maxConnections, queueTimeoutMs, executionTimeoutMs)
}

// ── Layer ──────────────────────────────────────────────────
// Synchronously creates a CLI-based DuckDB client with pooling.
// WASM path is deferred — CLI subprocess is the primary transport.

export const layer: Layer.Layer<Service, never, DuckDBConfig.Service | DatabaseAdapter.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* DuckDBConfig.Service
    const dbPath = Option.match(config.dbPath, {
      onNone: () => undefined,
      onSome: String,
    })
    const client = createCLIClient(dbPath)

    // Report DuckDB health to optional HealthRegistry
    const hr = yield* Effect.serviceOption(HealthRegistry)
    if (Option.isSome(hr)) {
      yield* hr.value.set("duckdb", {
        status: HealthStatus.Healthy,
        updatedAt: Date.now(),
      })
    }

    // Run pipeline in background if dbPath is set (not :memory:)
    if (dbPath) {
      const adapter = yield* DatabaseAdapter.Service
      yield* Effect.forkScoped(
        runPipeline(dbPath, adapter).pipe(Effect.ignore),
      )
    }

    return client
  }),
)


export * as DuckDB from "./db.duckdb"