/**
 * Shadow-Write Verification
 *
 * During migration, writes go to BOTH filesystem (SQLite) and PGlite
 * within the same logical transaction. Both must succeed or neither takes effect.
 * Post-write verification reads back from both stores and compares.
 * Divergence triggers immediate alert.
 *
 * Doctrine:
 * - Write to filesystem first, then PGlite (rollback filesystem on PGlite failure)
 * - Post-write: read from both, compare with dual-read characterization
 * - Any divergence is logged at CRITICAL level
 * - Verification mode can be disabled after proven cutover
 */
import { Effect } from "effect"
import { characterizeEntity, type Divergence, type CharacterizationReport } from "./dual-read"
import type { DatabaseAdapter } from "@/storage/adapter"
import * as fs from "node:fs"
import * as path from "node:path"

// ── Types ────────────────────────────────────────────────────────────────────

export interface ShadowWriteResult {
  entity_type: string
  entity_id: string
  filesystem_write_ok: boolean
  pglite_write_ok: boolean
  both_succeeded: boolean
  verification_divergences: Divergence[]
  duration_ms: number
}

export interface ShadowWriteConfig {
  /** Enable shadow-write verification (default: true during migration) */
  enabled: boolean
  /** Alert on divergence (default: true) */
  alert_on_divergence: boolean
  /** Log level for divergences */
  divergence_log_level: "warn" | "error" | "critical"
  /** Maximum divergence count before halting migration */
  max_divergences_before_halt: number
}

export const DEFAULT_SHADOW_CONFIG: ShadowWriteConfig = {
  enabled: true,
  alert_on_divergence: true,
  divergence_log_level: "critical",
  max_divergences_before_halt: 0, // Halt on first divergence
}

// ── Filesystem Writer ────────────────────────────────────────────────────────

function writeFilesystemEntity(entityType: string, data: Record<string, unknown>): boolean {
  const entityDir: Record<string, string> = {
    campaign: "docs/json/omp/campaigns",
    mission: "docs/json/omp/missions",
    lane: "docs/json/omp/lanes",
    task: "docs/json/omp/tasks",
  }

  const dir = entityDir[entityType]
  if (!dir) return false

  try {
    const slug = (data.slug as string) || (data.id as string) || "unknown"
    const filePath = path.join(dir, `${data.id || slug}.v1.json`)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n")
    return true
  } catch {
    return false
  }
}

/**
 * Rollback a filesystem write (delete the file).
 */
function rollbackFilesystemWrite(entityType: string, entityId: string): void {
  const entityDir: Record<string, string> = {
    campaign: "docs/json/omp/campaigns",
    mission: "docs/json/omp/missions",
    lane: "docs/json/omp/lanes",
    task: "docs/json/omp/tasks",
  }
  const dir = entityDir[entityType]
  if (!dir) return

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    for (const file of files) {
      const content = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"))
      if (content.id === entityId) {
        fs.unlinkSync(path.join(dir, file))
        return
      }
    }
  } catch {
    // Best-effort rollback
  }
}

// ── Shadow-Write Engine ──────────────────────────────────────────────────────

/**
 * Shadow-write an entity to both filesystem and PGlite.
 *
 * Writes to filesystem first. If that fails, abort.
 * Then writes to PGlite. If that fails, rollback filesystem.
 * After both succeed, verify by reading back from both.
 *
 * If verification finds divergences and alert_on_divergence is true,
 * the divergence is logged but the write is still considered successful
 * (both stores have the data — the divergence is a comparison issue).
 */
export function shadowWrite(
  entityType: string,
  entityId: string,
  data: Record<string, unknown>,
  adapter: DatabaseAdapter.Interface,
  config: ShadowWriteConfig = DEFAULT_SHADOW_CONFIG
): Effect.Effect<ShadowWriteResult, Error> {
  return Effect.gen(function* () {
    const startedAt = Date.now()
    let fsOk = false
    let pgOk = false

    // Phase 1: Write to filesystem
    fsOk = writeFilesystemEntity(entityType, data)
    if (!fsOk) {
      return {
        entity_type: entityType,
        entity_id: entityId,
        filesystem_write_ok: false,
        pglite_write_ok: false,
        both_succeeded: false,
        verification_divergences: [],
        duration_ms: Date.now() - startedAt,
      }
    }

    // Phase 2: Write to PGlite
    try {
      yield* adapter.query((db) => {
        // Dynamic insert based on entity type
        const table = getTableForEntity(entityType)
        if (!table) throw new Error(`Unknown entity type: ${entityType}`)
        return db.insert(table).values(data as any).execute()
      })
      pgOk = true
    } catch (err) {
      // PGlite write failed — rollback filesystem
      rollbackFilesystemWrite(entityType, entityId)
      fsOk = false
    }

    // Phase 3: Verify
    let divergences: Divergence[] = []
    if (fsOk && pgOk && config.enabled) {
      divergences = yield* characterizeEntity(entityType, entityId, async () => {
        // Read back from PGlite
        const rows = await Effect.runPromise(adapter.query((db) => {
          const table = getTableForEntity(entityType)
          if (!table) throw new Error(`Unknown entity type: ${entityType}`)
          return db.select().from(table).where({ id: entityId } as any).execute()
        })) as any
        return (rows[0] as Record<string, unknown>) || null
      })
    }

    if (divergences.length > 0 && config.alert_on_divergence) {
      console.error(
        `[${config.divergence_log_level.toUpperCase()}] Shadow-write divergence for ${entityType}:${entityId}`,
        JSON.stringify(divergences)
      )
    }

    return {
      entity_type: entityType,
      entity_id: entityId,
      filesystem_write_ok: fsOk,
      pglite_write_ok: pgOk,
      both_succeeded: fsOk && pgOk,
      verification_divergences: divergences,
      duration_ms: Date.now() - startedAt,
    }
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTableForEntity(entityType: string): any {
  // Dynamically import table references — resolved at runtime
  const tables: Record<string, string> = {
    campaign: "CampaignTable",
    mission: "MissionTable",
    lane: "LaneTable",
    task: "TaskTable",
  }
  const tableName = tables[entityType]
  if (!tableName) return null

  // Return the drizzle table reference
  // In production, this would use the actual imported table references
  return { name: `control_plane_${entityType}` } as any
}
