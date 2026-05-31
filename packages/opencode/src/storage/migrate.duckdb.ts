import { runPipeline } from "./pipeline"
import { makeLocalPgAdapter } from "./adapter"
import { Effect } from "effect"
import path from "path"
import os from "os"

const DEFAULT_DB_PATH = path.join(os.homedir(), ".opencode", "analytics.duckdb")

function resolveDbPath(): string {
  const args = process.argv.slice(2)
  const dbPathIndex = args.indexOf("--db-path")
  if (dbPathIndex !== -1 && args[dbPathIndex + 1]) {
    return args[dbPathIndex + 1]
  }
  if (process.env["OPENCODE_DUCKDB_PATH"]) {
    return process.env["OPENCODE_DUCKDB_PATH"]
  }
  return DEFAULT_DB_PATH
}

function run(): void {
  const dbPath = resolveDbPath()
  console.log("DuckDB pipeline: starting", { dbPath })

  const adapter = makeLocalPgAdapter()
  Effect.runPromise(runPipeline(dbPath, adapter))
    .then(() => {
      console.log("DuckDB pipeline completed")
      process.exit(0)
    })
    .catch((err) => {
      console.error("DuckDB pipeline failed:", err)
      process.exit(1)
    })
}

if (import.meta.main) {
  run()
}
