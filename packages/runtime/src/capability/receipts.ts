import { eq, desc, and } from "../storage/db"
import * as Database from "../storage/db"
import { CapabilityAuthorityReceiptTable } from "./receipts.pg.sql"
import { ulid } from "ulid"
import { Effect } from "effect"

export interface AuthorityReceiptSummary {
  receiptID: string
  createdAt: number
  capabilityID: string
  actionName: string
  sessionID: string | null
  projectID: string | null
  outcome: string
  reasons: string[]
  message: string | null
  authorityChain: any[]
  missingAuthority: string[]
  recoveryState: string
  requiredApproval: string
  effectiveApproval: string | null
  requiredBoundaries: string[]
  grantedBoundaries: string[]
  consentClass: string
}

export function persistAuthorityReceipt(receipt: {
  capabilityId: string
  actionName: string
  sessionId?: string
  projectId?: string
  authorityOutcome: "allowed" | "refused"
  refusalReasons?: string[]
  authorityChain?: any[]
  missingAuthority?: string[]
  recoveryState: string
  approvalLevel: string
  privilegeBoundaries: string[]
  consentClass: string
}) {
  return Effect.promise(() =>
    Database.use((db) =>
      db
        .insert(CapabilityAuthorityReceiptTable)
        .values({
          id: ulid(),
          timestamp: Date.now(),
          capability_id: receipt.capabilityId,
          action_name: receipt.actionName,
          session_id: receipt.sessionId ?? null,
          project_id: receipt.projectId ?? null,
          authority_outcome: receipt.authorityOutcome,
          refusal_reasons: receipt.refusalReasons ?? [],
          authority_chain: receipt.authorityChain ?? [],
          missing_authority: receipt.missingAuthority ?? [],
          recovery_state: receipt.recoveryState,
          approval_level: receipt.approvalLevel,
          privilege_boundaries: receipt.privilegeBoundaries,
          consent_class: receipt.consentClass,
        })
        .execute()
    )
  )
}

export function queryAuthorityReceipts(filters: {
  sessionId: string
  capabilityId?: string
  outcome?: string
  actionName?: string
  limit?: number
}) {
  const clampedLimit = Math.min(Math.max(filters.limit ?? 20, 1), 100)

  return Effect.promise<AuthorityReceiptSummary[]>(() =>
    Database.use(async (db) => {
      const conditions = [eq(CapabilityAuthorityReceiptTable.session_id, filters.sessionId)]

      if (filters.capabilityId) {
        conditions.push(eq(CapabilityAuthorityReceiptTable.capability_id, filters.capabilityId))
      }
      if (filters.outcome) {
        conditions.push(eq(CapabilityAuthorityReceiptTable.authority_outcome, filters.outcome))
      }
      if (filters.actionName) {
        conditions.push(eq(CapabilityAuthorityReceiptTable.action_name, filters.actionName))
      }

      const rows = await db
        .select()
        .from(CapabilityAuthorityReceiptTable)
        .where(and(...conditions))
        .orderBy(desc(CapabilityAuthorityReceiptTable.timestamp))
        .limit(clampedLimit)
        .execute()

      return rows.map((row: any) => {
        // Safe mapping & JSON parsing/shaping
        const rawChain = row.authority_chain
        const authorityChain = Array.isArray(rawChain) ? rawChain : []
        const requiredBoundaries = Array.isArray(row.privilege_boundaries)
          ? (row.privilege_boundaries as string[])
          : []

        // Extract effective approval from chain if allowed
        let effectiveApproval: string | null = null
        if (row.authority_outcome === "allowed" && authorityChain.length > 0) {
          effectiveApproval = authorityChain[0].approvalLevel ?? null
        }

        // Derive message or fallback to default
        let message = row.authority_outcome === "allowed"
          ? `Action authorized successfully`
          : `Action refused`
        if (row.refusal_reasons && row.refusal_reasons.length > 0) {
          if (row.refusal_reasons.includes("coordination_state_blocks_side_effect") || row.refusal_reasons.includes("coordination_state_blocks_mutation")) {
            message = `Capability is blocked because coordination is in state: ${row.recovery_state}`
          } else if (row.refusal_reasons.includes("human_approval_required")) {
            message = `Human approval required`
          } else if (row.refusal_reasons.includes("senior_approval_required")) {
            message = `Senior approval required`
          } else if (row.refusal_reasons.includes("privilege_boundary_not_granted")) {
            message = `Required privilege boundary not granted`
          } else if (row.refusal_reasons.includes("missing_authority_grant")) {
            message = `No valid authority grant found`
          }
        }

        return {
          receiptID: row.id,
          createdAt: row.timestamp,
          capabilityID: row.capability_id,
          actionName: row.action_name,
          sessionID: row.session_id,
          projectID: row.project_id,
          outcome: row.authority_outcome,
          reasons: row.refusal_reasons ?? [],
          message,
          authorityChain,
          missingAuthority: row.missing_authority ?? [],
          recoveryState: row.recovery_state,
          requiredApproval: row.approval_level,
          effectiveApproval,
          requiredBoundaries,
          grantedBoundaries: row.authority_outcome === "allowed" && authorityChain.length > 0
            ? (authorityChain[0].privilegeBoundaries ?? [])
            : [],
          consentClass: row.consent_class,
        }
      })
    })
  )
}
