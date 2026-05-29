import { PGlite } from "@electric-sql/pglite"
import { Pool } from "pg"
import { drizzle } from "drizzle-orm/pglite"
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { readMigrationFiles } from "drizzle-orm/migrator"
import type { PgliteDatabase } from "drizzle-orm/pglite"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"

export type PgClient = PgliteDatabase | NodePgDatabase

export function init(connectionString: string, ssl?: boolean): PgClient {
  if (connectionString === ":memory:" || connectionString.startsWith("/") || connectionString.startsWith("file:")) {
    const dataDir = connectionString === ":memory:" ? undefined : connectionString.replace(/^file:/, "")
    const client = new PGlite(dataDir)
    return drizzle({ client }) as PgliteDatabase
  }
  const pool = new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: true } : false,
  })
  return drizzlePg({ client: pool }) as NodePgDatabase
}

export async function applyMigrations(db: PgClient): Promise<void> {
  const folder = new URL("../../migration-pg", import.meta.url).pathname

  // Duck-type check: PGlite exposes exec() on its raw client
  const client = (db as any).$client
  if (typeof client.exec === "function") {
    // PGlite path: read migration files manually and execute each statement
    const migrations = readMigrationFiles({ migrationsFolder: folder })
    for (const migration of migrations) {
      for (const sql of migration.sql) {
        await client.exec(sql)
      }
    }
  } else {
    // node-postgres path: use drizzle's built-in migrator
    await migrate(db as NodePgDatabase, { migrationsFolder: folder })
  }
}
