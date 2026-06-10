/**
 * Mnemopi Sync Bridge — bidirectional sync between Mnemopi (bun:sqlite)
 * and the Tribunus managed PGlite store.
 *
 * Mnemopi default path: ~/.hermes/mnemopi/data/mnemopi.db
 * Configurable via MNEMOPI_DB_PATH
 */

import { join } from "node:path"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"
import type { PgliteDb } from "./store.js"

const DEFAULT_MNEMOPI_DB = join(homedir(), ".hermes", "mnemopi", "data", "mnemopi.db")

export interface MnemopiMemoryRow {
  id: string
  content: string
  source: string
  timestamp: string
  session_id: string
  importance: number
  memory_type: string
  scope: string
  metadata_json: string | null
}

export interface SyncResult {
  direction: "from_mnemopi" | "to_mnemopi"
  memories_synced: number
  memories_skipped: number
  errors: string[]
}

function getMnemopiPath(): string {
  return process.env.MNEMOPI_DB_PATH || DEFAULT_MNEMOPI_DB
}

function openMnemopi(): Database {
  return new Database(getMnemopiPath(), { readonly: false })
}

function openMnemopiReadOnly(): Database {
  return new Database(getMnemopiPath(), { readonly: true })
}

/** Pull memories from Mnemopi into the Tribunus PGlite store. */
export async function syncFromMnemopi(tribunusDb: PgliteDb): Promise<SyncResult> {
  const result: SyncResult = { direction: "from_mnemopi", memories_synced: 0, memories_skipped: 0, errors: [] }

  let mdb: Database
  try {
    mdb = openMnemopiReadOnly()
  } catch (e) {
    result.errors.push(`Failed to open Mnemopi DB: ${e instanceof Error ? e.message : String(e)}`)
    return result
  }

  try {
    // Ensure tribunus memory table exists
    await tribunusDb.exec(`
      CREATE TABLE IF NOT EXISTS mnemopi_memory (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT DEFAULT '',
        timestamp TEXT NOT NULL,
        session_id TEXT DEFAULT '',
        importance REAL DEFAULT 0.5,
        memory_type TEXT DEFAULT 'unknown',
        scope TEXT DEFAULT 'session',
        metadata_json TEXT,
        synced_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Pull working_memory rows
    const rows = mdb.query(`
      SELECT id, content, source, timestamp, session_id, importance,
             COALESCE(memory_type, 'unknown') as memory_type,
             COALESCE(scope, 'session') as scope,
             metadata_json
      FROM working_memory
      WHERE valid_until IS NULL OR valid_until > datetime('now')
      ORDER BY timestamp DESC
      LIMIT 1000
    `).all() as MnemopiMemoryRow[]

    for (const row of rows) {
      try {
        const existing = await tribunusDb.query(
          "SELECT 1 FROM mnemopi_memory WHERE id = $1",
          [row.id],
        )
        if (existing.rows.length > 0) {
          result.memories_skipped++
          continue
        }

        await tribunusDb.query(
          `INSERT INTO mnemopi_memory (id, content, source, timestamp, session_id, importance, memory_type, scope, metadata_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [row.id, row.content, row.source, row.timestamp, row.session_id,
           row.importance, row.memory_type, row.scope, row.metadata_json],
        )
        result.memories_synced++
      } catch (e) {
        result.errors.push(`Failed to sync memory ${row.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } finally {
    mdb.close()
  }

  return result
}

/** Push Tribunus memories to Mnemopi's working_memory table. */
export async function syncToMnemopi(tribunusDb: PgliteDb): Promise<SyncResult> {
  const result: SyncResult = { direction: "to_mnemopi", memories_synced: 0, memories_skipped: 0, errors: [] }

  let mdb: Database
  try {
    mdb = openMnemopi()
  } catch (e) {
    result.errors.push(`Failed to open Mnemopi DB: ${e instanceof Error ? e.message : String(e)}`)
    return result
  }

  try {
    // Get memories from tribunus that haven't been pushed yet
    const rows = await tribunusDb.query(`
      SELECT id, content, source, timestamp, session_id, importance, memory_type, scope, metadata_json
      FROM mnemopi_memory
      WHERE id NOT IN (SELECT id FROM mnemopi_push_log)
      ORDER BY timestamp ASC
      LIMIT 500
    `)

    await tribunusDb.exec(`
      CREATE TABLE IF NOT EXISTS mnemopi_push_log (
        id TEXT PRIMARY KEY,
        pushed_at TIMESTAMP DEFAULT NOW()
      )
    `)

    for (const row of rows.rows) {
      try {
        // Check if already exists in mnemopi
        const existing = mdb.query("SELECT 1 FROM working_memory WHERE id = ?").get(row.id as string)
        if (existing) {
          await tribunusDb.query("INSERT OR IGNORE INTO mnemopi_push_log (id) VALUES ($1)", [row.id])
          result.memories_skipped++
          continue
        }

        mdb.run(
          `INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, memory_type, scope, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.content, row.source, row.timestamp, row.session_id,
           row.importance, row.memory_type, row.scope, row.metadata_json],
        )

        await tribunusDb.query("INSERT OR IGNORE INTO mnemopi_push_log (id) VALUES ($1)", [row.id])
        result.memories_synced++
      } catch (e) {
        result.errors.push(`Failed to push memory ${row.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } finally {
    mdb.close()
  }

  return result
}

/** Query synced memories from the Tribunus store. */
export async function queryMemories(
  tribunusDb: PgliteDb,
  query: string,
  limit: number = 20,
): Promise<Array<Record<string, unknown>>> {
  const result = await tribunusDb.query(
    `SELECT id, content, source, timestamp, importance, memory_type, scope
     FROM mnemopi_memory
     WHERE content LIKE $1
     ORDER BY importance DESC, timestamp DESC
     LIMIT $2`,
    [`%${query}%`, limit],
  )
  return result.rows
}
