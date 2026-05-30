/**
 * migrate-to-pg CLI command
 *
 * Migrates data from the local SQLite database (opencode.db) to a Postgres
 * database. Designed as a one-time structural migration tool that bypasses
 * the adapter layer for BOTH source and destination:
 *
 * - SOURCE (SQLite): Opened directly via bun:sqlite. The Database adapter is
 *   intentionally bypassed because the migrate-to-pg command needs raw read
 *   access to all tables without Drizzle abstraction — it is exporting from a
 *   pre-existing SQLite database that may have schema differences from the
 *   adapter's expectations.
 *
 * - DESTINATION (Postgres): Written directly via the pg Pool client. The
 *   adapter layer is intentionally bypassed because we are populating a fresh
 *   database that the adapter itself depends on being fully migrated (the
 *   adapter constructs its own Drizzle ORM bindings from the database schema).
 *
 * FK Audit: Before any data is copied, every foreign key relationship defined
 * in the SQLite schemas is checked for orphaned records. If any violations
 * exist, the migration halts with a detailed report and a non-zero exit code.
 *
 * The target Postgres database must exist and have its DDL migrations applied
 * before running this command (run `opencode db migrate-pg-schema` or
 * equivalent first).
 */

import type { Argv } from "yargs"
import { Database as BunDatabase } from "bun:sqlite"
import { Pool } from "pg"
import { PGlite } from "@electric-sql/pglite"
import { EOL } from "os"
import { Database } from "@/storage/db"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { errorMessage } from "../../util/error"
import { createHash } from "crypto"
import path from "path"
import fs from "fs"

// ── FK relationship definitions ──────────────────────────────
// Derived from the drizzle-orm SQLite table definitions.
// nullable: true means the FK allows NULL values (checked as IS NOT NULL first).

interface FKRelation {
  table: string
  column: string
  refTable: string
  refColumn: string
  nullable: boolean
}

const FK_RELATIONS: FKRelation[] = [
  { table: "session", column: "project_id", refTable: "project", refColumn: "id", nullable: false },
  { table: "session", column: "workspace_id", refTable: "workspace", refColumn: "id", nullable: true },
  { table: "session", column: "parent_id", refTable: "session", refColumn: "id", nullable: true },
  { table: "message", column: "session_id", refTable: "session", refColumn: "id", nullable: false },
  { table: "part", column: "message_id", refTable: "message", refColumn: "id", nullable: false },
  { table: "part", column: "session_id", refTable: "session", refColumn: "id", nullable: false },
  { table: "todo", column: "session_id", refTable: "session", refColumn: "id", nullable: false },
  { table: "session_message", column: "session_id", refTable: "session", refColumn: "id", nullable: false },
  { table: "permission", column: "project_id", refTable: "project", refColumn: "id", nullable: false },
  { table: "session_share", column: "session_id", refTable: "session", refColumn: "id", nullable: false },
  { table: "workspace", column: "project_id", refTable: "project", refColumn: "id", nullable: false },
  { table: "event", column: "aggregate_id", refTable: "event_sequence", refColumn: "aggregate_id", nullable: false },
  { table: "account_state", column: "active_account_id", refTable: "account", refColumn: "id", nullable: true },
]

// ── Type conversion maps ─────────────────────────────────────
// Columns stored as text({mode:"json"}) in SQLite → jsonb() in PG
// need their string values parsed into JS objects before insertion.

const JSON_COLUMNS: Record<string, string[]> = {
  project: ["sandboxes", "commands"],
  workspace: ["extra"],
  session: ["summary_diffs", "revert", "permission", "model"],
  message: ["data"],
  part: ["data"],
  session_message: ["data"],
  permission: ["data"],
  event: ["data"],
}

// Columns stored as integer({mode:"boolean"}) in SQLite → boolean() in PG.
const BOOLEAN_COLUMNS: Record<string, string[]> = {
  control_account: ["active"],
}

// ── Table copy order (parents before children) ───────────────
const TABLE_ORDER: string[] = [
  "project",
  "account",
  "event_sequence",
  "workspace",
  "session",
  "account_state",
  "message",
  "session_share",
  "part",
  "todo",
  "session_message",
  "permission",
  "control_account",
  "event",
  "data_migration",
]

// ── SQL injection prevention ─────────────────────────────────
// Table names and column names are validated against an allowlist
// and escaped with double-quoted identifiers before any SQL
// interpolation.

const ALLOWED_TABLES = new Set(TABLE_ORDER)

function isAllowedTable(name: string): name is string {
  return ALLOWED_TABLES.has(name)
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function isValidColumnName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)
}

function requireAllowedTable(name: string): string {
  if (!isAllowedTable(name)) {
    throw new Error(`Table "${name}" is not in the migration allowlist; refusing SQL interpolation`)
  }
  return quoteIdent(name)
}

function requireValidColumn(name: string): string {
  if (!isValidColumnName(name)) {
    throw new Error(`Column name "${name}" contains invalid characters; refusing SQL interpolation`)
  }
  return quoteIdent(name)
}

// ── FK violation model ───────────────────────────────────────

interface FKViolation {
  table: string
  column: string
  refTable: string
  id: string
}

// ── Progress reporting ───────────────────────────────────────

interface MigrationStats {
  tableName: string
  rowCount: number
}

interface TableVerificationResult {
  tableName: string
  sqliteRowCount: number
  pgRowCount: number
  sqliteChecksum: string
  pgChecksum: string
  rowCountsMatch: boolean
  checksumsMatch: boolean
}

// ── Helpers ──────────────────────────────────────────────────

function formatViolationReport(violations: FKViolation[]): string {
  const lines: string[] = []
  lines.push("")
  lines.push(UI.Style.TEXT_DANGER_BOLD + "Foreign Key Violations Found" + UI.Style.TEXT_NORMAL)
  lines.push("─".repeat(60))

  const byTable = new Map<string, FKViolation[]>()
  for (const v of violations) {
    if (!byTable.has(v.table)) byTable.set(v.table, [])
    byTable.get(v.table)!.push(v)
  }

  for (const [table, tableViolations] of byTable) {
    lines.push(`${table}:`)
    for (const v of tableViolations) {
      lines.push(`  ${v.column} → ${v.refTable}  (missing ref: ${v.id})`)
    }
  }

  lines.push("")
  lines.push(`${violations.length} total FK violation(s) found. Migration halted.${EOL}`)
  return lines.join(EOL)
}

function maybeParseJSON(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function convertValue(value: unknown, isJson: boolean, isBool: boolean): unknown {
  if (value === null || value === undefined) return null
  if (isJson) return maybeParseJSON(value)
  if (isBool) return value === 1 || value === true || value === "1"
  return value
}

/**
 * Normalise a PGlite connection string to a file path.
 * PGlite accepts `/path` or `file:///path` or `memory://`.
 */
function isPGliteUrl(url: string): boolean {
  return url.startsWith("/") || url.startsWith("file:") || url.startsWith("memory:")
}

// ── Verification helpers ─────────────────────────────────────

/**
 * Compute a SHA256 checksum of all data in a table.
 * Concatenates all rows' canonical form (tab-separated values, null → \N,
 * newline-delimited), then hashes the resulting byte sequence.
 */
function computeTableChecksum(rows: Record<string, unknown>[]): string {
  const hash = createHash("sha256")
  for (const row of rows) {
    const canonical = Object.values(row)
      .map((v) => (v === null || v === undefined ? "\\N" : String(v)))
      .join("\t")
    hash.update(canonical)
    hash.update("\n")
  }
  return hash.digest("hex")
}

/**
 * Execute a read-only query against PGlite or pg Pool and return all rows.
 */
async function queryPgAll(
  pgClient: Pool | PGlite,
  sql: string,
  params?: unknown[],
): Promise<Record<string, unknown>[]> {
  if (pgClient instanceof PGlite) {
    const result = await pgClient.query(sql, params)
    return result.rows as Record<string, unknown>[]
  }
  const client = await pgClient.connect()
  try {
    const result = await client.query(sql, params)
    return result.rows as Record<string, unknown>[]
  } finally {
    client.release()
  }
}

/**
 * Verify a single table by comparing row counts and SHA256 checksums
 * between SQLite source and Postgres destination.
 */
async function verifyTableData(
  sqlite: BunDatabase,
  pgClient: Pool | PGlite,
  tableName: string,
): Promise<TableVerificationResult> {
  const safeTable = requireAllowedTable(tableName)

  // Row counts
  const sqliteCountRow = sqlite.query<{ cnt: number }, []>(
    `SELECT COUNT(*) AS cnt FROM ${safeTable}`,
  ).get()
  const sqliteRowCount = sqliteCountRow?.cnt ?? 0

  const pgCountRows = await queryPgAll(
    pgClient,
    `SELECT COUNT(*)::bigint AS cnt FROM ${safeTable}`,
  )
  const pgRowCount = Number(pgCountRows[0]?.cnt ?? 0)

  // Ordered data for checksum comparison
  // Use ORDER BY all columns (ordinal position) for deterministic ordering
  const sqliteRows = sqlite.query<Record<string, unknown>, []>(
    `SELECT * FROM ${safeTable} ORDER BY 1`,
  ).all()

  const pgRows = await queryPgAll(
    pgClient,
    `SELECT * FROM ${safeTable} ORDER BY 1`,
  )

  const sqliteChecksum = computeTableChecksum(sqliteRows)
  const pgChecksum = computeTableChecksum(pgRows)

  return {
    tableName,
    sqliteRowCount,
    pgRowCount,
    sqliteChecksum,
    pgChecksum,
    rowCountsMatch: sqliteRowCount === pgRowCount,
    checksumsMatch: sqliteChecksum === pgChecksum,
  }
}

// ── Rollback helpers ─────────────────────────────────────────

/**
 * Rename the SQLite database file to `.pre-pg-migration` as a rollback
 * backup. Throws if the original does not exist or if a backup already
 * exists (to prevent accidental overwrite of a previous backup).
 */
function renameForRollback(originalPath: string): void {
  const backupPath = originalPath + ".pre-pg-migration"

  if (!fs.existsSync(originalPath)) {
    throw new Error(`SQLite database not found at ${originalPath}`)
  }

  if (fs.existsSync(backupPath)) {
    throw new Error(
      `Rollback backup already exists at ${backupPath}. ` +
        `Remove it manually or restore it first to re-run migration.`,
    )
  }

  fs.renameSync(originalPath, backupPath)
}

/**
 * Create a flag file at `.rig/postgres-migration-complete` in the
 * same directory as the database to signal a successful migration.
 */
function createMigrationFlag(dbPath: string): string {
  const rigDir = path.join(path.dirname(dbPath), ".rig")
  const flagPath = path.join(rigDir, "postgres-migration-complete")
  fs.mkdirSync(rigDir, { recursive: true })
  fs.writeFileSync(flagPath, new Date().toISOString(), "utf-8")
  return flagPath
}

// ── FK Audit ─────────────────────────────────────────────────

function runFKAudit(sqlite: BunDatabase): FKViolation[] {
  const violations: FKViolation[] = []

  for (const fk of FK_RELATIONS) {
    // Validate and escape FK identifiers for any SQL interpolation
    const qTable = requireAllowedTable(fk.table)
    const qRefTable = requireAllowedTable(fk.refTable)
    const qColumn = requireValidColumn(fk.column)
    const qRefColumn = requireValidColumn(fk.refColumn)

    // Check if source table exists (parameterized — safe as-is)
    const tableExists = sqlite.query<string, [string]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(fk.table)
    if (!tableExists) continue

    // Check if ref table exists (parameterized — safe as-is)
    const refTableExists = sqlite.query<string, [string]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(fk.refTable)

    if (!refTableExists) {
      // Ref table does not exist at all — every non-null ref is orphaned
      const countRow = sqlite.query<{ cnt: number }, []>(
        `SELECT COUNT(*) AS cnt FROM ${qTable} WHERE ${qColumn} IS NOT NULL`,
      ).get()
      const totalCount = countRow?.cnt ?? 0
      if (totalCount > 0) {
        const rows = sqlite.query<Record<string, unknown>, []>(
          `SELECT ${qColumn} AS val FROM ${qTable} WHERE ${qColumn} IS NOT NULL`,
        ).all()
        for (const row of rows) {
          violations.push({
            table: fk.table,
            column: fk.column,
            refTable: fk.refTable,
            id: String(row.val),
          })
        }
      }
      continue
    }

    // Build safe WHERE clause with validated and quoted identifiers
    const whereClause = fk.nullable
      ? `${qColumn} IS NOT NULL AND ${qColumn} NOT IN (SELECT ${qRefColumn} FROM ${qRefTable})`
      : `${qColumn} NOT IN (SELECT ${qRefColumn} FROM ${qRefTable})`

    // Use COUNT-based detection first, then fetch all violations
    const countRow = sqlite.query<{ cnt: number }, []>(
      `SELECT COUNT(*) AS cnt FROM ${qTable} WHERE ${whereClause}`,
    ).get()
    const totalCount = countRow?.cnt ?? 0
    if (totalCount > 0) {
      const rows = sqlite.query<Record<string, unknown>, []>(
        `SELECT ${qColumn} AS val FROM ${qTable} WHERE ${whereClause}`,
      ).all()
      for (const row of rows) {
        violations.push({
          table: fk.table,
          column: fk.column,
          refTable: fk.refTable,
          id: String(row.val),
        })
      }
    }
  }

  return violations
}

// ── Data copy ────────────────────────────────────────────────

async function getTableNames(sqlite: BunDatabase): Promise<string[]> {
  const rows = sqlite.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
  ).all()
  return rows.map((r) => r.name)
}

async function copyTable(
  sqlite: BunDatabase,
  pgClient: Pool | PGlite,
  tableName: string,
): Promise<number> {
  const safeTable = requireAllowedTable(tableName)

  // Read all rows from SQLite
  const rows = sqlite.query<Record<string, unknown>, []>(
    `SELECT * FROM ${safeTable}`,
  ).all()

  if (rows.length === 0) return 0

  // Determine JSON and boolean columns for this table
  const jsonCols = new Set(JSON_COLUMNS[tableName] ?? [])
  const boolCols = new Set(BOOLEAN_COLUMNS[tableName] ?? [])

  // Get all column names from the first row (ordered as in SELECT *)
  const columnNames = Object.keys(rows[0])
  // Validate and quote each column name for safe SQL interpolation
  const quotedColumns = columnNames.map((col) => requireValidColumn(col))
  const placeholders = columnNames.map((_, i) => `$${i + 1}`).join(", ")
  const columns = quotedColumns.join(", ")
  const insertSql = `INSERT INTO ${safeTable} (${columns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`

  // Prepare converted rows
  const convertedRows = rows.map((row) =>
    columnNames.map((col) =>
      convertValue(row[col], jsonCols.has(col), boolCols.has(col)),
    ),
  )

  if (pgClient instanceof PGlite) {
    // PGlite: batch via its exec
    for (const values of convertedRows) {
      await pgClient.query(insertSql, values)
    }
  } else {
    // pg Pool: use a single client in batch mode
    const client = await pgClient.connect()
    try {
      for (const values of convertedRows) {
        await client.query(insertSql, values)
      }
    } finally {
      client.release()
    }
  }

  return rows.length
}

// ── Connection setup ─────────────────────────────────────────

function createPgClient(pgUrl: string): Pool | PGlite {
  if (isPGliteUrl(pgUrl)) {
    const filePath = pgUrl.replace(/^file:/, "")
    return new PGlite(filePath)
  }
  return new Pool({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } })
}

async function closePgClient(client: Pool | PGlite): Promise<void> {
  if (client instanceof PGlite) {
    await client.close()
  } else {
    await client.end()
  }
}

// ── Command ──────────────────────────────────────────────────

export const MigrateToPgCommand = cmd({
  command: "migrate-to-pg [pg-url]",
  describe:
    "migrate data from local SQLite database to Postgres (requires existing PG schema)",
  builder: (yargs: Argv) =>
    yargs
      .positional("pg-url", {
        type: "string",
        describe:
          "Postgres connection string (postgresql://user:pass@host/db) or PGlite path (/path or file:///path). Falls back to PG_URL env var if omitted.",
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "run FK audit only, do not copy data",
      })
      .option("force", {
        type: "boolean",
        default: false,
        describe: "skip FK audit and proceed with migration",
      })
      .option("skip-verify", {
        type: "boolean",
        default: false,
        describe: "skip post-migration row count and checksum verification",
      }),
  handler: async (args) => {
    const pgUrl = (args.pgUrl as string | undefined) ?? process.env.PG_URL
    const dryRun = args.dryRun as boolean
    const force = args.force as boolean
    const skipVerify = args.skipVerify as boolean

    if (!pgUrl) {
      UI.error(
        "Postgres connection string is required. Provide it as a positional argument or set the PG_URL environment variable.",
      )
      process.exit(1)
    }

    const dbPath = Database.getPath()
    const backupPath = dbPath + ".pre-pg-migration"

    // ── Phase 0: Rollback preparation ──────────────────────
    // Rename the active SQLite database to preserve it as a rollback
    // backup. After this point, a fresh SQLite db will be created on
    // next app launch if Postgres is not configured.
    if (!dryRun) {
      UI.println(`${UI.Style.TEXT_DIM}Preparing rollback backup...${UI.Style.TEXT_NORMAL}`)
      try {
        renameForRollback(dbPath)
      } catch (err) {
        UI.error(`Cannot prepare rollback backup: ${errorMessage(err)}`)
        process.exit(1)
      }
      UI.println(`${UI.Style.TEXT_DIM}SQLite renamed to rollback copy: ${backupPath}${UI.Style.TEXT_NORMAL}`)
    }

    // ── Phase 1: Open SQLite (source) ──────────────────────
    // On dry-run, read the original path (no rename happened).
    // On real migration, read from the renamed backup.
    const sourcePath = dryRun ? dbPath : backupPath
    UI.println(`${UI.Style.TEXT_DIM}Opening SQLite source: ${sourcePath}${UI.Style.TEXT_NORMAL}`)

    let sqlite: BunDatabase | undefined
    try {
      sqlite = new BunDatabase(sourcePath, { readonly: true })
    } catch (err) {
      UI.error(`Cannot open SQLite database at ${sourcePath}: ${errorMessage(err)}`)
      process.exit(1)
    }

    let pgClient: Pool | PGlite | undefined
    let verificationPassed = false

    try {
      // ── Phase 2: FK Audit ──────────────────────────────────
      if (!force) {
        UI.println(`${UI.Style.TEXT_DIM}Running FK audit...${UI.Style.TEXT_NORMAL}`)
        const violations = runFKAudit(sqlite!)
        if (violations.length > 0) {
          UI.println(formatViolationReport(violations))
          UI.println(
            `Use ${UI.Style.TEXT_HIGHLIGHT}--force${UI.Style.TEXT_NORMAL} to skip the audit and migrate anyway.`,
          )
          process.exit(1)
        }
        UI.println(`${UI.Style.TEXT_SUCCESS}FK audit passed — no orphaned records found.${UI.Style.TEXT_NORMAL}`)
      }

      if (dryRun) {
        UI.println(`${UI.Style.TEXT_HIGHLIGHT}Dry run complete. No data was copied.${UI.Style.TEXT_NORMAL}`)
        return
      }

      // ── Phase 3: Connect to Postgres (destination) ───────
      UI.println(`${UI.Style.TEXT_DIM}Connecting to Postgres...${UI.Style.TEXT_NORMAL}`)
      try {
        pgClient = createPgClient(pgUrl)
      } catch (err) {
        UI.error(`Cannot connect to Postgres: ${errorMessage(err)}`)
        process.exit(1)
      }

      try {
        // Test the connection
        if (pgClient instanceof PGlite) {
          await pgClient.query("SELECT 1")
        } else if (pgClient) {
          const testClient = await pgClient.connect()
          try {
            await testClient.query("SELECT 1")
          } finally {
            testClient.release()
          }
        }
      } catch (err) {
        UI.error(`Postgres connection failed: ${errorMessage(err)}`)
        process.exit(1)
      }

      // ── Phase 4: Copy data ──────────────────────────────
      const allTableNames = await getTableNames(sqlite!)

      // Order by dependency. Unknown tables (not in TABLE_ORDER) are
      // excluded because they cannot pass the allowlist validation.
      const orderedTables = TABLE_ORDER.filter((t) => allTableNames.includes(t))

      const stats: MigrationStats[] = []
      let totalRows = 0

      for (const tableName of orderedTables) {
        UI.println(`${UI.Style.TEXT_DIM}Copying ${tableName}...${UI.Style.TEXT_NORMAL}`)
        const rowCount = await copyTable(sqlite!, pgClient!, tableName)
        if (rowCount > 0) {
          UI.println(`  ${rowCount} rows`)
        }
        stats.push({ tableName, rowCount })
        totalRows += rowCount
      }

      // ── Phase 5: Post-migration verification ────────────
      if (!skipVerify) {
        UI.println("")
        UI.println(`${UI.Style.TEXT_DIM}Running post-migration verification...${UI.Style.TEXT_NORMAL}`)

        const verificationResults: TableVerificationResult[] = []
        let allMatch = true

        for (const tableName of orderedTables) {
          const result = await verifyTableData(sqlite!, pgClient!, tableName)
          verificationResults.push(result)

          if (!result.rowCountsMatch || !result.checksumsMatch) {
            allMatch = false
            UI.println(
              `${UI.Style.TEXT_DANGER}${tableName}: MISMATCH${UI.Style.TEXT_NORMAL}` +
                ` (rows: ${result.sqliteRowCount} vs ${result.pgRowCount},` +
                ` sha256: ${result.sqliteChecksum} vs ${result.pgChecksum})`,
            )
          } else {
            UI.println(
              `  ${tableName}: ${UI.Style.TEXT_SUCCESS}OK${UI.Style.TEXT_NORMAL}` +
                ` (${result.sqliteRowCount} rows, sha256:${result.sqliteChecksum.substring(0, 12)}…)`,
            )
          }
        }

        if (allMatch) {
          verificationPassed = true
          UI.println("")
          UI.println(
            `${UI.Style.TEXT_SUCCESS_BOLD}Verification passed — all tables match.${UI.Style.TEXT_NORMAL}`,
          )
        } else {
          UI.println("")
          UI.println(
            `${UI.Style.TEXT_DANGER_BOLD}Verification FAILED — discrepancies found.${UI.Style.TEXT_NORMAL}`,
          )
          UI.println(`Rollback backup preserved at: ${backupPath}`)
          UI.println(
            "To restore: stop Postgres usage, unset OPENCODE_DATABASE_URL," +
              ` and run: mv ${backupPath} ${dbPath}`,
          )
          process.exit(1)
        }
      } else {
        verificationPassed = true
      }

      // ── Phase 6: Migration flag ─────────────────────────
      if (verificationPassed) {
        const flagPath = createMigrationFlag(dbPath)
        UI.println(`${UI.Style.TEXT_DIM}Migration flag: ${flagPath}${UI.Style.TEXT_NORMAL}`)
      }

      // ── Summary ─────────────────────────────────────────
      UI.println("")
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD +
          "Migration complete." +
          UI.Style.TEXT_NORMAL,
      )
      UI.println(`Total rows copied: ${totalRows}`)
      UI.println("Tables migrated:")
      for (const s of stats) {
        const label = `${s.tableName}:`.padEnd(24)
        UI.println(`  ${label}${s.rowCount} rows`)
      }
    } finally {
      sqlite?.close()
      if (pgClient) await closePgClient(pgClient)
    }
  },
})
