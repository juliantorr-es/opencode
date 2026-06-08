import { createHash } from "node:crypto"
import type { OmpToolEnvelopeV1, OmpToolContextV1, OmpErrorCodeV1, OmpRiskLevel } from "./types.js"

let _context: OmpToolContextV1 | null = null

export function setContext(ctx: OmpToolContextV1): void {
  _context = ctx
}

function getContext(): OmpToolContextV1 {
  if (!_context) throw new Error("OMP context not set — call setContext(ctx) first")
  return _context
}

export type CreateEnvelopeOpts = {
  tool_id: string
  tool_version: string
  invocation_id: string
  /** ISO-8601 timestamp captured by the caller before work began */
  started_at: string
  receipt_id?: string
  status: "ok" | "error" | "refused"
  risk_level: OmpRiskLevel
  requires_approval: boolean
  requires_hash_precondition: boolean
  approval_id?: string
  result?: unknown
  error?: {
    code: OmpErrorCodeV1
    message: string
    details?: unknown
    retryable: boolean
  }
  evidence?: OmpToolEnvelopeV1["evidence"]
  read_paths?: string[]
  written_paths?: string[]
  denied_paths?: string[]
  policy_reasons?: string[]
}

export function createEnvelope(opts: CreateEnvelopeOpts): OmpToolEnvelopeV1 {
  const ctx = getContext()
  const finishedAt = new Date()
  const startedAtMs = new Date(opts.started_at).getTime()

  const inputSha256 = opts.result !== undefined
    ? createHash("sha256").update(JSON.stringify(opts.result), "utf-8").digest("hex")
    : ""

  const policyDecision: "allowed" | "refused" =
    opts.status === "refused" ? "refused" : "allowed"

  return {
    schema: "omp.tool.envelope.v1",
    tool_id: opts.tool_id,
    tool_version: opts.tool_version,
    invocation_id: opts.invocation_id,
    receipt_id: opts.receipt_id,
    status: opts.status,
    started_at: opts.started_at,
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAtMs,
    cwd: ctx.cwd,
    actor: ctx.actor,
    input: {
      sha256: inputSha256,
    },
    policy: {
      risk_level: opts.risk_level,
      requires_approval: opts.requires_approval,
      approval_id: opts.approval_id,
      requires_hash_precondition: opts.requires_hash_precondition,
      policy_decision: policyDecision,
      policy_reasons: opts.policy_reasons ?? [],
    },
    paths: {
      read: opts.read_paths ?? [],
      written: opts.written_paths ?? [],
      denied: opts.denied_paths ?? [],
    },
    result: opts.result,
    evidence: opts.evidence,
    error: opts.error,
  }
}
