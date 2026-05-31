// ── DuckDB Write-Capable Subprocess Helpers ────────────────
//
// Shared write-capable exec helpers for pipeline and schema DDL.
// These functions spawn `duckdb` WITHOUT the `-readonly` flag, so
// DDL (CREATE TABLE, CREATE VIEW, INSERT, etc.) is accepted at the
// process level. They are NOT for user-facing queries — use the
// read-only client from db.duckdb.ts for that path.
//
// Error type is DuckDBWriteError (from duckdb-pipe.ts) so callers
// can discriminate write failures with Effect.catchTag("DuckDBWriteError").

import { spawn } from "child_process"
import { DuckDBWriteError } from "./duckdb-pipe"

/** Spawn duckdb (no -readonly) and execute SQL via -c flag. */
export function execDuckDB(dbPath: string, sql: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("duckdb", [dbPath, "-json", "-c", sql])
    let stderr = ""
    const timer = setTimeout(() => {
      proc.kill()
      reject(new DuckDBWriteError("duckdb timeout after 60s"))
    }, 60_000)

    const onAbort = signal
      ? () => {
          proc.kill()
          reject(new DuckDBWriteError("duckdb aborted via signal"))
        }
      : undefined

    if (onAbort) signal!.addEventListener("abort", onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener("abort", onAbort)
    }

    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
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
  })
}

/** Spawn duckdb (no -readonly) with stdin JSON data for bulk inserts. */
export function execDuckDBStdin(dbPath: string, sql: string, data: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("duckdb", [dbPath, "-json", "-c", sql])
    let stderr = ""
    const timer = setTimeout(() => {
      proc.kill()
      reject(new DuckDBWriteError("duckdb timeout after 60s"))
    }, 60_000)

    const onAbort = signal
      ? () => {
          proc.kill()
          reject(new DuckDBWriteError("duckdb aborted via signal"))
        }
      : undefined

    if (onAbort) signal!.addEventListener("abort", onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener("abort", onAbort)
    }

    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
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
    proc.stdin?.end(data)
  })
}
