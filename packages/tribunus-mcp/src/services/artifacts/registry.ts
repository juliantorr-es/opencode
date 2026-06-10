import * as crypto from "node:crypto"
import { rename } from "node:fs/promises"
import type { PgliteDb } from "../../governance/store.js"
import type { ArtifactRecord, ArtifactState, ArtifactType, DestinationMode, RetentionPolicy, VerificationReceipt, ArtifactRelationship, RelationshipKind } from "./types.js"
import { validateTransition } from "./lifecycle.js"
import { ArtifactNotFoundError, ArtifactConflictError, ArtifactDigestMismatchError, ArtifactStateError } from "./errors.js"
import { fileDigest } from "./identity.js"

export interface ReserveInput {
  artifactType: ArtifactType
  logicalName?: string
  canonicalPath: string
  destinationMode: DestinationMode
  retentionPolicy?: RetentionPolicy
  invocationId?: string
  sessionId?: string
  parentInvocationId?: string
  sourceCommit?: string
  sourceDirty?: boolean
  idempotencyKey?: string
}

export interface ReserveOutput {
  artifactId: string
  canonicalPath: string
  tempPath: string
  artifactType: ArtifactType
}

export interface FinalizeInput {
  artifactId: string
  tempPath: string
  contentDigest?: string
  byteCount?: number
  fileCount?: number
  mimeType?: string
  producerTool?: string
  producerToolVersion?: string
  invocationId?: string
  normalizedArgumentDigest?: string
  metadata?: Record<string, unknown>
  idempotencyKey?: string
}

export interface FinalizeOutput {
  artifactId: string
  canonicalPath: string
  contentDigest: string
  byteCount: number
  fileCount: number
  state: ArtifactState
}

export class ArtifactRegistryService {
  constructor(private db: PgliteDb) {}

  private async emitEvent(
    artifactId: string,
    prior: ArtifactState | null,
    next: ArtifactState,
    eventType: string,
    invocationId?: string,
    reason?: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const id = crypto.randomUUID()
    await this.db.query(
      `INSERT INTO artifact_events (event_id, artifact_id, prior_state, next_state, event_type, invocation_id, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, artifactId, prior, next, eventType, invocationId || null, reason || null, meta ? JSON.stringify(meta) : null],
    )
  }

  async reserve(input: ReserveInput): Promise<ReserveOutput> {
    const artifactId = `artifact-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
    const tempPath = input.canonicalPath + ".tmp." + Date.now()

    const existing = await this.db.query(
      "SELECT artifact_id FROM artifacts_v2 WHERE canonical_path = $1 AND state NOT IN ('deleted','missing','superseded')",
      [input.canonicalPath],
    )
    if (existing.rows.length > 0) {
      throw new ArtifactConflictError(input.canonicalPath, existing.rows[0].artifact_id as string)
    }

    await this.db.query(
      `INSERT INTO artifacts_v2 (
        artifact_id, artifact_type, logical_name, state, canonical_path, destination_mode,
        retention_policy, invocation_id, parent_invocation_id, session_id, source_commit, source_dirty
      ) VALUES ($1,$2,$3,'reserved',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        artifactId, input.artifactType, input.logicalName || null, input.canonicalPath,
        input.destinationMode, input.retentionPolicy || "mission_evidence",
        input.invocationId || null, input.parentInvocationId || null, input.sessionId || null,
        input.sourceCommit || null, input.sourceDirty ?? null,
      ],
    )

    await this.emitEvent(artifactId, null, "reserved", "artifact_reserved", input.invocationId)
    return { artifactId, canonicalPath: input.canonicalPath, tempPath, artifactType: input.artifactType }
  }

  async beginProduction(artifactId: string, invocationId?: string): Promise<void> {
    const record = await this.get(artifactId)
    validateTransition(artifactId, record.state, "producing")
    await this.db.query("UPDATE artifacts_v2 SET state = 'producing' WHERE artifact_id = $1", [artifactId])
    await this.emitEvent(artifactId, record.state, "producing", "artifact_production_started", invocationId)
  }

  async finalizeFile(input: FinalizeInput): Promise<FinalizeOutput> {
    const record = await this.get(input.artifactId)
    if (record.state === "finalized" && input.idempotencyKey) {
      if (record.content_digest === input.contentDigest) {
        return {
          artifactId: record.artifact_id,
          canonicalPath: record.canonical_path,
          contentDigest: record.content_digest!,
          byteCount: record.byte_count!,
          fileCount: record.file_count || 1,
          state: record.state,
        }
      }
      throw new ArtifactDigestMismatchError(input.artifactId, record.content_digest || "unknown", input.contentDigest || "unknown")
    }

    validateTransition(input.artifactId, record.state, "finalized")

    let digest = input.contentDigest
    let byteCount = input.byteCount
    if (!digest) {
      const result = await fileDigest(input.tempPath)
      digest = result.digest
      byteCount = byteCount || result.byteCount
    }

    await rename(input.tempPath, record.canonical_path)

    await this.db.query(
      `UPDATE artifacts_v2 SET state='finalized', content_digest=$1, byte_count=$2, file_count=$3,
       finalized_at=(to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
       mime_type=$4, producer_tool=$5, producer_tool_version=$6,
       normalized_argument_digest=$7, metadata=$8
       WHERE artifact_id=$9`,
      [digest, byteCount, input.fileCount || 1, input.mimeType || null, input.producerTool || null, input.producerToolVersion || null, input.normalizedArgumentDigest || null, input.metadata ? JSON.stringify(input.metadata) : null, input.artifactId],
    )

    await this.emitEvent(input.artifactId, record.state, "finalized", "artifact_finalized", input.invocationId)
    return { artifactId: input.artifactId, canonicalPath: record.canonical_path, contentDigest: digest!, byteCount: byteCount || 0, fileCount: input.fileCount || 1, state: "finalized" }
  }

  async finalizeDirectory(input: FinalizeInput & { manifestDigest: string }): Promise<FinalizeOutput> {
    const record = await this.get(input.artifactId)
    validateTransition(input.artifactId, record.state, "finalized")

    let digest = input.contentDigest
    let byteCount = input.byteCount
    if (!digest) {
      const result = await fileDigest(input.tempPath)
      digest = result.digest
      byteCount = byteCount || result.byteCount
    }

    await rename(input.tempPath, record.canonical_path)

    await this.db.query(
      `UPDATE artifacts_v2 SET state='finalized', content_digest=$1, manifest_digest=$2, byte_count=$3, file_count=$4,
       finalized_at=(to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
       mime_type=$5, producer_tool=$6, metadata=$7 WHERE artifact_id=$8`,
      [digest, input.manifestDigest, byteCount, input.fileCount, input.mimeType || null, input.producerTool || null, input.metadata ? JSON.stringify(input.metadata) : null, input.artifactId],
    )

    await this.emitEvent(input.artifactId, record.state, "finalized", "artifact_finalized", input.invocationId)
    return { artifactId: input.artifactId, canonicalPath: record.canonical_path, contentDigest: digest!, byteCount: byteCount || 0, fileCount: input.fileCount || 1, state: "finalized" }
  }

  async verify(artifactId: string, receipt: VerificationReceipt): Promise<void> {
    const record = await this.get(artifactId)

    if (receipt.status === "passed") {
      validateTransition(artifactId, record.state, "verified")
      await this.db.query(
        `INSERT INTO artifact_verifications (verification_id, artifact_id, artifact_type, observed_digest, verifier_name, status, checks_json, invocation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [receipt.verification_id, artifactId, receipt.artifact_type, receipt.observed_digest, receipt.verifier_name, receipt.status, JSON.stringify(receipt.checks), receipt.invocation_id || null],
      )
      await this.db.query(
        "UPDATE artifacts_v2 SET state='verified', verification_status='passed', verification_receipt_id=$1, verified_at=(to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE artifact_id=$2",
        [receipt.verification_id, artifactId],
      )
      await this.emitEvent(artifactId, record.state, "verified", "artifact_verified", receipt.invocation_id || undefined)
    } else {
      validateTransition(artifactId, record.state, "verification_failed")
      await this.db.query(
        "UPDATE artifacts_v2 SET state='verification_failed', verification_status='failed' WHERE artifact_id=$1",
        [artifactId],
      )
      await this.emitEvent(artifactId, record.state, "verification_failed", "artifact_verification_failed", receipt.invocation_id || undefined)
    }
  }

  async markPartial(artifactId: string, reason?: string): Promise<void> {
    const record = await this.get(artifactId)
    validateTransition(artifactId, record.state, "partial")
    await this.db.query("UPDATE artifacts_v2 SET state='partial' WHERE artifact_id=$1", [artifactId])
    await this.emitEvent(artifactId, record.state, "partial", "artifact_partial", undefined, reason)
  }

  async quarantine(artifactId: string, reason?: string): Promise<void> {
    const record = await this.get(artifactId)
    validateTransition(artifactId, record.state, "quarantined")
    await this.db.query("UPDATE artifacts_v2 SET state='quarantined' WHERE artifact_id=$1", [artifactId])
    await this.emitEvent(artifactId, record.state, "quarantined", "artifact_quarantined", undefined, reason)
  }

  async supersede(artifactId: string, supersededById: string): Promise<void> {
    const record = await this.get(artifactId)
    validateTransition(artifactId, record.state, "superseded")
    await this.db.query(
      "UPDATE artifacts_v2 SET state='superseded', superseded_by_id=$1, superseded_at=(to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE artifact_id=$2",
      [supersededById, artifactId],
    )
    await this.emitEvent(artifactId, record.state, "superseded", "artifact_superseded")
  }

  async markMissing(artifactId: string): Promise<void> {
    const record = await this.get(artifactId)
    validateTransition(artifactId, record.state, "missing")
    await this.db.query("UPDATE artifacts_v2 SET state='missing' WHERE artifact_id=$1", [artifactId])
    await this.emitEvent(artifactId, record.state, "missing", "artifact_missing")
  }

  async requestDeletion(artifactId: string): Promise<void> {
    const record = await this.get(artifactId)
    validateTransition(artifactId, record.state, "deletion_pending")
    await this.db.query("UPDATE artifacts_v2 SET state='deletion_pending', deleted_at=(to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE artifact_id=$1", [artifactId])
    await this.emitEvent(artifactId, record.state, "deletion_pending", "artifact_deletion_requested")
  }

  async completeDeletion(artifactId: string): Promise<void> {
    const record = await this.get(artifactId)
    if (record.state !== "deletion_pending") throw new ArtifactStateError(artifactId, record.state, "deleted")
    await this.db.query("UPDATE artifacts_v2 SET state='deleted' WHERE artifact_id=$1", [artifactId])
    await this.emitEvent(artifactId, record.state, "deleted", "artifact_deleted")
  }

  async import(input: {
    artifactType: ArtifactType
    canonicalPath: string
    invocationId?: string
    sourceCommit?: string
    logicalName?: string
    retentionPolicy?: RetentionPolicy
  }): Promise<ArtifactRecord> {
    const artifactId = `artifact-import-${crypto.randomUUID()}`
    const result = await fileDigest(input.canonicalPath)

    await this.db.query(
      `INSERT INTO artifacts_v2 (artifact_id, artifact_type, logical_name, state, content_digest, canonical_path, byte_count, file_count, provenance, retention_policy, invocation_id, source_commit, finalized_at)
       VALUES ($1,$2,$3,'finalized',$4,$5,$6,1,'imported',$7,$8,$9,(to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`,
      [artifactId, input.artifactType, input.logicalName || null, result.digest, input.canonicalPath, result.byteCount, input.retentionPolicy || "imported_external", input.invocationId || null, input.sourceCommit || null],
    )

    return this.get(artifactId)
  }

  async get(artifactId: string): Promise<ArtifactRecord> {
    const result = await this.db.query("SELECT * FROM artifacts_v2 WHERE artifact_id = $1", [artifactId])
    if (result.rows.length === 0) throw new ArtifactNotFoundError(artifactId)
    return this.mapRow(result.rows[0])
  }

  async list(filters: {
    artifactType?: ArtifactType
    state?: ArtifactState
    producerTool?: string
    invocationId?: string
    sessionId?: string
    sourceCommit?: string
    contentDigest?: string
    pathPrefix?: string
    verificationStatus?: string
    cursor?: string
    limit?: number
  } = {}): Promise<{ artifacts: ArtifactRecord[]; nextCursor: string | null }> {
    const conditions: string[] = []
    const params: unknown[] = []
    let idx = 1

    if (filters.artifactType) { conditions.push(`artifact_type = $${idx++}`); params.push(filters.artifactType) }
    if (filters.state) { conditions.push(`state = $${idx++}`); params.push(filters.state) }
    if (filters.producerTool) { conditions.push(`producer_tool = $${idx++}`); params.push(filters.producerTool) }
    if (filters.invocationId) { conditions.push(`invocation_id = $${idx++}`); params.push(filters.invocationId) }
    if (filters.contentDigest) { conditions.push(`content_digest = $${idx++}`); params.push(filters.contentDigest) }
    if (filters.pathPrefix) { conditions.push(`canonical_path LIKE $${idx++}`); params.push(filters.pathPrefix + "%") }
    if (filters.verificationStatus) { conditions.push(`verification_status = $${idx++}`); params.push(filters.verificationStatus) }
    if (filters.cursor) {
      const [cursorTs, cursorId] = filters.cursor.split(",")
      conditions.push(`(created_at, artifact_id) < ($${idx++}, $${idx++})`)
      params.push(cursorTs, cursorId)
    }

    const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : ""
    const limit = Math.min(filters.limit || 20, 100)

    const rows = await this.db.query(
      `SELECT * FROM artifacts_v2 ${where} ORDER BY created_at DESC, artifact_id DESC LIMIT $${idx}`,
      [...params, limit + 1],
    )

    const hasMore = rows.rows.length > limit
    const artifacts = (hasMore ? rows.rows.slice(0, limit) : rows.rows).map(r => this.mapRow(r))
    const nextCursor = hasMore && artifacts.length > 0
      ? `${artifacts[artifacts.length - 1].created_at},${artifacts[artifacts.length - 1].artifact_id}`
      : null

    return { artifacts, nextCursor }
  }

  async addRelationship(sourceId: string, destId: string, kind: RelationshipKind, invocationId?: string, meta?: Record<string, unknown>): Promise<void> {
    await this.db.query(
      "INSERT OR IGNORE INTO artifact_relationships (source_artifact_id, destination_artifact_id, relationship, invocation_id, metadata) VALUES ($1,$2,$3,$4,$5)",
      [sourceId, destId, kind, invocationId || null, meta ? JSON.stringify(meta) : null],
    )
  }

  async getLineage(artifactId: string, direction: "upstream" | "downstream" | "both", depth: number = 3): Promise<ArtifactRelationship[]> {
    if (direction === "upstream" || direction === "both") {
      const upstream = await this.db.query(
        `WITH RECURSIVE lineage AS (
          SELECT * FROM artifact_relationships WHERE destination_artifact_id = $1
          UNION ALL
          SELECT ar.* FROM artifact_relationships ar JOIN lineage l ON ar.destination_artifact_id = l.source_artifact_id
        ) SELECT * FROM lineage LIMIT $2`,
        [artifactId, depth * 10],
      )
      if (direction === "upstream") return upstream.rows as unknown as ArtifactRelationship[]
    }
    return []
  }

  private mapRow(row: Record<string, unknown>): ArtifactRecord {
    let metadata: Record<string, unknown> | null = null
    if (row.metadata && typeof row.metadata === "string") {
      try { metadata = JSON.parse(row.metadata as string) } catch {}
    }
    return {
      artifact_id: row.artifact_id as string,
      schema_version: Number(row.schema_version || 1),
      artifact_type: row.artifact_type as ArtifactRecord["artifact_type"],
      logical_name: row.logical_name as string | null,
      state: row.state as ArtifactRecord["state"],
      content_algorithm: (row.content_algorithm as string) || "sha256",
      content_digest: row.content_digest as string | null,
      manifest_digest: row.manifest_digest as string | null,
      canonical_path: row.canonical_path as string,
      byte_count: row.byte_count as number | null,
      file_count: row.file_count as number | null,
      mime_type: row.mime_type as string | null,
      producer_tool: row.producer_tool as string | null,
      producer_tool_version: row.producer_tool_version as string | null,
      invocation_id: row.invocation_id as string | null,
      parent_invocation_id: row.parent_invocation_id as string | null,
      session_id: row.session_id as string | null,
      source_commit: row.source_commit as string | null,
      source_dirty: row.source_dirty as boolean | null,
      normalized_argument_digest: row.normalized_argument_digest as string | null,
      capability_policy_digest: row.capability_policy_digest as string | null,
      machine_profile_digest: row.machine_profile_digest as string | null,
      created_at: row.created_at as string,
      finalized_at: row.finalized_at as string | null,
      verified_at: row.verified_at as string | null,
      superseded_at: row.superseded_at as string | null,
      deleted_at: row.deleted_at as string | null,
      verification_status: (row.verification_status as ArtifactRecord["verification_status"]) || "none",
      verification_receipt_id: row.verification_receipt_id as string | null,
      superseded_by_id: row.superseded_by_id as string | null,
      retention_policy: (row.retention_policy as ArtifactRecord["retention_policy"]) || "mission_evidence",
      destination_mode: (row.destination_mode as ArtifactRecord["destination_mode"]) || "exact_path",
      provenance: (row.provenance as ArtifactRecord["provenance"]) || "tribunus_produced",
      metadata,
    }
  }
}
