import { spawn } from "child_process"

// ── Error ──────────────────────────────────────────────────

export class DuckDBWriteError extends Error {
  readonly _tag = "DuckDBWriteError"
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "DuckDBWriteError"
  }
}

// ── Write Pipe ─────────────────────────────────────────────

/**
 * Execute SQL against a DuckDB database by piping the SQL to stdin.
 *
 * Spawns the `duckdb` CLI with only the database path (no `-readonly`,
 * no `-json`, no `-c` flag), writes the SQL to stdin, and waits for
 * completion. On non-zero exit, throws a `DuckDBWriteError` with the
 * collected stderr content.
 */
export async function execDuckDBWrite(dbPath: string, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("duckdb", [dbPath])
    let stderr = ""

    const timer = setTimeout(() => {
      proc.kill()
      reject(new DuckDBWriteError("duckdb timeout after 60s"))
    }, 60_000)

    const cleanup = () => {
      clearTimeout(timer)
    }

    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    proc.stdout?.on("data", () => {}) // drain stdout
    proc.on("close", (code) => {
      cleanup()
      if (code !== 0) reject(new DuckDBWriteError(`duckdb failed: ${stderr}`))
      else resolve()
    })
    proc.on("error", (err) => {
      cleanup()
      reject(err)
    })
    proc.stdin?.end(sql)
  })
}

export * as DuckDBPipe from "./duckdb-pipe"
