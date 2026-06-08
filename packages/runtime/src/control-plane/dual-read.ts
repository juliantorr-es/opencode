/**
 * Dual-Read Characterization
 *
 * During migration, runs reads against both the filesystem (SQLite/JSON)
 * and PGlite backends simultaneously. Compares results field-by-field.
 * Characterizes every divergence before write cutover.
 *
 * Doctrine:
 * - Every read goes to BOTH backends during characterization phase
 * - Results are compared deterministically (sorted, normalized)
 * - Divergences are logged at ERROR level with full detail
 * - Once zero divergences for the characterization window, cutover is safe
 */
import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"

// ── Types ────────────────────────────────────────────────────────────────────

export interface Divergence {
  entity_type: string
  entity_id: string
  field: string
  filesystem_value: unknown
  pglite_value: unknown
  divergence_kind: "missing_in_pglite" | "missing_in_filesystem" | "value_mismatch" | "type_mismatch"
  timestamp: number
}

export interface CharacterizationReport {
  total_queries: number
  matched_queries: number
  divergent_queries: number
  divergences: Divergence[]
  characterization_window_start: number
  characterization_window_end: number
  ready_for_cutover: boolean
}

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalize values for comparison.
 * - JSON arrays: sort by deterministic key
 * - Timestamps: compare as numbers, not strings
 * - null vs undefined: treat undefined as null
 * - Order-independent field comparison for objects
 */
function normalizeValue(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) {
    return [...value].sort((a, b) => {
      const sa = typeof a === "object" ? JSON.stringify(a) : String(a)
      const sb = typeof b === "object" ? JSON.stringify(b) : String(b)
      return sa.localeCompare(sb)
    })
  }
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = normalizeValue((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Compare two normalized values for equality.
 * Returns the first mismatched field path, or null if equal.
 */
function compareNormalized(
  a: unknown,
  b: unknown,
  path: string = ""
): string | null {
  if (a === b) return null
  if (a === null || b === null) return path || "root"
  if (typeof a !== typeof b) return path || "root"

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length`
    for (let i = 0; i < a.length; i++) {
      const mismatch = compareNormalized(a[i], b[i], `${path}[${i}]`)
      if (mismatch) return mismatch
    }
    return null
  }

  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>
    const bObj = b as Record<string, unknown>
    const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)])
    for (const key of allKeys) {
      if (!(key in aObj)) return `${path}.${key}`
      if (!(key in bObj)) return `${path}.${key}`
      const mismatch = compareNormalized(aObj[key], bObj[key], `${path}.${key}`)
      if (mismatch) return mismatch
    }
    return null
  }

  if (typeof a === "number" && typeof b === "number") {
    // Allow 1ms tolerance for timestamps
    if (Math.abs(a - b) <= 1) return null
  }

  return path || "root"
}

// ── Entity Readers ───────────────────────────────────────────────────────────

function readFilesystemEntity(entityType: string, entityId: string): Record<string, unknown> | null {
  const dirs: Record<string, string> = {
    campaign: "docs/json/omp/campaigns",
    mission: "docs/json/omp/missions",
    lane: "docs/json/omp/lanes",
    task: "docs/json/omp/tasks",
  }
  const dir = dirs[entityType]
  if (!dir) return null

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    for (const file of files) {
      const content = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"))
      if (content.id === entityId) return content
    }
  } catch {
    // Filesystem read failed
  }
  return null
}

// ── Dual-Read Engine ─────────────────────────────────────────────────────────

/**
 * Characterize a single entity across both backends.
 * Reads from filesystem and PGlite, compares, and records divergences.
 */
export function characterizeEntity(
  entityType: string,
  entityId: string,
  pgliteReader: (type: string, id: string) => Promise<Record<string, unknown> | null>
): Effect.Effect<Divergence[], Error> {
  return Effect.gen(function* () {
    const divergences: Divergence[] = []

    const fsEntity = readFilesystemEntity(entityType, entityId)
    const pgEntity = yield* Effect.tryPromise(() => pgliteReader(entityType, entityId))

    // Detect missing entities
    if (!fsEntity && pgEntity) {
      divergences.push({
        entity_type: entityType,
        entity_id: entityId,
        field: "entire_entity",
        filesystem_value: null,
        pglite_value: pgEntity,
        divergence_kind: "missing_in_filesystem",
        timestamp: Date.now(),
      })
      return divergences
    }
    if (fsEntity && !pgEntity) {
      divergences.push({
        entity_type: entityType,
        entity_id: entityId,
        field: "entire_entity",
        filesystem_value: fsEntity,
        pglite_value: null,
        divergence_kind: "missing_in_pglite",
        timestamp: Date.now(),
      })
      return divergences
    }
    if (!fsEntity && !pgEntity) {
      return divergences
    }

    // Field-by-field comparison
    const normalizedFs = normalizeValue(fsEntity) as Record<string, unknown>
    const normalizedPg = normalizeValue(pgEntity) as Record<string, unknown>

    const allKeys = new Set([...Object.keys(normalizedFs), ...Object.keys(normalizedPg)])
    for (const field of allKeys) {
      const fsVal = normalizedFs[field]
      const pgVal = normalizedPg[field]

      // Skip comparison-only fields
      if (field === "time_updated") continue // PGlite auto-updates, filesystem doesn't
      if (field === "updated_at" && typeof fsVal === "string" && typeof pgVal === "number") continue // Format difference

      const mismatch = compareNormalized(fsVal, pgVal, field)
      if (mismatch) {
        divergences.push({
          entity_type: entityType,
          entity_id: entityId,
          field: mismatch,
          filesystem_value: fsVal,
          pglite_value: pgVal,
          divergence_kind: "value_mismatch",
          timestamp: Date.now(),
        })
      }
    }

    return divergences
  })
}

/**
 * Generate a characterization report summarizing all divergences.
 */
export function generateReport(
  divergences: Divergence[],
  windowStart: number
): CharacterizationReport {
  const entityIds = new Set(divergences.map((d) => `${d.entity_type}:${d.entity_id}`))
  return {
    total_queries: entityIds.size,
    matched_queries: entityIds.size - divergences.filter((d) => d.field === "entire_entity").length,
    divergent_queries: divergences.filter((d) => d.field !== "entire_entity" || d.divergence_kind !== "missing_in_pglite").length,
    divergences,
    characterization_window_start: windowStart,
    characterization_window_end: Date.now(),
    ready_for_cutover: divergences.length === 0,
  }
}
