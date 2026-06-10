/**
 * Artifact Recovery — detection and safe repair of artifact anomalies.
 */

import { existsSync, unlinkSync } from "node:fs"
import type { PgliteDb } from "../../governance/store.js"
import { ArtifactRegistryService } from "./registry.js"

export interface ArtifactRecoveryReport {
  stale_reservations: number
  stale_reservation_ids: string[]
  missing_bytes: number
  missing_byte_ids: string[]
  orphaned_temps: string[]
  ready_for_delete: number
}

export async function scanArtifacts(
  db: PgliteDb,
): Promise<ArtifactRecoveryReport> {
  const registry = new ArtifactRegistryService(db)

  const staleReservations = await db.query(
    "SELECT artifact_id, canonical_path FROM artifacts_v2 WHERE state IN ('reserved','producing') AND created_at < ((to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))::timestamp - INTERVAL '30 minutes')",
  )

  // Check finalized artifacts for missing bytes
  const finalized = await db.query(
    "SELECT artifact_id, canonical_path FROM artifacts_v2 WHERE state = 'finalized'",
  )
  const missingBytes: string[] = []
  for (const row of finalized.rows) {
    if (!existsSync(row.canonical_path as string)) {
      missingBytes.push(row.artifact_id as string)
    }
  }

  // Check for records in deletion_pending
  const pendingDeletion = await db.query(
    "SELECT artifact_id FROM artifacts_v2 WHERE state = 'deletion_pending'",
  )

  return {
    stale_reservations: staleReservations.rows.length,
    stale_reservation_ids: staleReservations.rows.map(r => r.artifact_id as string),
    missing_bytes: missingBytes.length,
    missing_byte_ids: missingBytes,
    orphaned_temps: [],
    ready_for_delete: pendingDeletion.rows.length,
  }
}

export async function repairArtifacts(
  db: PgliteDb,
  report: ArtifactRecoveryReport,
): Promise<{ repaired: number; errors: string[] }> {
  const registry = new ArtifactRegistryService(db)
  const errors: string[] = []
  let repaired = 0

  for (const id of report.stale_reservation_ids) {
    try {
      await registry.markPartial(id)
      repaired++
    } catch (e) {
      errors.push(`Failed to mark ${id} partial: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  for (const id of report.missing_byte_ids) {
    try {
      await registry.markMissing(id)
      repaired++
    } catch (e) {
      errors.push(`Failed to mark ${id} missing: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { repaired, errors }
}
