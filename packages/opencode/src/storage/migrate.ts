import { Database as BunDatabase } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate as sqliteMigrate } from "drizzle-orm/bun-sqlite/migrator"
import { init as initPg, applyMigrations } from "#db"
import { Global } from "@opencode-ai/core/global"
import path from "path"

const MIGRATIONS_SQLITE = path.join(import.meta.dirname, "../../migration")

export type Dialect = "sqlite" | "pg"

export interface MigrateOptions {
  dialect?: Dialect
  dbPath?: string
  connectionString?: string
  ssl?: boolean
}

function detectDialect(): Dialect {
  const override = process.env["OPENCODE_DATABASE_DIALECT"]
  if (override === "sqlite" || override === "pg") return override
  if (process.env["OPENCODE_DATABASE_URL"]) return "pg"
  return "sqlite"
}

function resolveDbPath(opts: MigrateOptions): string {
  if (opts.dbPath) return opts.dbPath
  if (process.env["OPENCODE_SQLITE_DB_PATH"]) return process.env["OPENCODE_SQLITE_DB_PATH"]
  return path.join(Global.Path.data, "opencode.db")
}

export async function runMigrations(opts: MigrateOptions = {}): Promise<void> {
  const dialect = opts.dialect ?? detectDialect()

  if (dialect === "sqlite") {
    const dbPath = resolveDbPath(opts)
    const sqlite = new BunDatabase(dbPath)
    try {
      const db = drizzle({ client: sqlite })
      await sqliteMigrate(db, { migrationsFolder: MIGRATIONS_SQLITE })
    } finally {
      sqlite.close()
    }
  } else {
    const url = opts.connectionString ?? process.env["OPENCODE_DATABASE_URL"]
    if (!url) {
      throw new Error(
        "OPENCODE_DATABASE_URL is required for PG migrations. " +
        "Set the OPENCODE_DATABASE_URL environment variable or pass --connection-string.",
      )
    }
    const ssl = opts.ssl ?? process.env["OPENCODE_DATABASE_SSL"] !== "false"
    const client = initPg(url, ssl)
    try {
      await applyMigrations(client)
    } finally {
      // Close the underlying pool/client (PGlite has no end(), node-postgres Pool does)
      const underlying = (client as any).$client
      if (underlying && typeof underlying.end === "function") {
        await underlying.end()
      }
    }
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2)
  const forceDialect: Dialect | undefined =
    args.includes("--pg") ? "pg" :
    args.includes("--sqlite") ? "sqlite" :
    undefined
  const dbPathIndex = args.indexOf("--db-path")
  const dbPath = dbPathIndex !== -1 ? args[dbPathIndex + 1] : undefined
  const connStrIndex = args.indexOf("--conn-string")
  const connString = connStrIndex !== -1 ? args[connStrIndex + 1] : undefined

  runMigrations({ dialect: forceDialect, dbPath, connectionString: connString })
    .then(() => {
      console.log("Migrations applied successfully")
      process.exit(0)
    })
    .catch((err) => {
      console.error("Migration failed:", err)
      process.exit(1)
    })
}
