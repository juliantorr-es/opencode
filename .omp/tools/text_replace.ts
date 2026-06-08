import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { sha256, sha256Json } from "./_lib/hashing.js"
import { setContext, createEnvelope } from "./_lib/envelope.js"
import type { CreateEnvelopeOpts } from "./_lib/envelope.js"
import { resolveWritePath } from "./_lib/path-policy.js"
import { buildToolContext } from "./_lib/tool-context.js"
import { validateTextReplaceInput } from "./_lib/schemas.js"
import type { TextReplaceInputV1 } from "./_lib/schemas.js"
import { buildReceipt, writeReceipt, writeDiffArtifact, allocateReceiptPath } from "./_lib/receipts.js"
import { appendAuditEvent } from "./_lib/audit.js"
import { createInvocationId, createReceiptId, createEventId } from "./_lib/ids.js"
import { toolError } from "./_lib/errors.js"
import type { OmpToolEnvelopeV1, OmpRiskLevel, OmpToolEventV1 } from "./_lib/types.js"
import { getPgliteStore } from "./_lib/store/pglite-store.js"
import type { OmpRelationalStoreV1 } from "./_lib/store/pglite-types.js"

const VERSION = "1.0.0"
const TOOL_ID = "text_replace"
const RISK_LEVEL: OmpRiskLevel = "write_medium"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const factory: CustomToolFactory = (pi) => ({
  name: TOOL_ID,
  label: "Text Replace",
  description:
    "Search and replace literal text in a file using exact string matching. Use this for surgical edits where you know the exact text to replace. Not regex — no escaping surprises. For line-based edits, use the built-in edit tool instead.",
  parameters: pi.zod.object({
    file: pi.zod.string().describe("File to modify, relative to project root"),
    old: pi.zod.string().describe("Exact text to replace — literal match, no regex"),
    new: pi.zod.string().describe("Replacement text"),
    reason: pi.zod.string().describe("Why this replacement is needed"),
    expected_before_sha256: pi.zod
      .string()
      .optional()
      .describe("SHA-256 of the file before mutation. Required when allow_unverified_write is false."),
    idempotent: pi.zod
      .boolean()
      .optional()
      .default(false)
      .describe("If true and new text already present exactly once, return ok with skip note instead of refusing."),
    allow_unverified_write: pi.zod
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true and expected_before_sha256 is missing, proceed with warning instead of refusing with HASH_MISMATCH.",
      ),
  }),

  async execute(
    _toolCallId: string,
    params: {
      file: string
      old: string
      new: string
      reason: string
      expected_before_sha256?: string
      idempotent?: boolean
      allow_unverified_write?: boolean
    },
    onUpdate:
      | ((update: { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }) => void)
      | undefined,
    ctx: { sessionId?: string } | undefined,
    signal: AbortSignal | undefined,
  ) {
    const startedAt = new Date().toISOString()
    const sessionId = ctx?.sessionId || `omp_ses_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`

    // --- Build and set OMP context ---
    const ompCtx = buildToolContext({
      cwd: pi.cwd,
      repoRoot: pi.cwd,
      mode: "loose",
      actor:
        ctx?.sessionId
          ? { kind: "agent", session_id: ctx.sessionId }
          : { kind: "unknown" },
    })

    // If PGlite is available, initialize store and session
    let store: OmpRelationalStoreV1 | undefined
    if (existsSync(resolve(pi.cwd, "node_modules/@electric-sql/pglite"))) {
      try {
        store = getPgliteStore({ repoRoot: ompCtx.repo_root })
        await store.migrate()
        await store.createSession({ session_id: sessionId, actor_id: "unknown" })
        ;(ompCtx as { store?: OmpRelationalStoreV1 }).store = store
      } catch { /* loose mode: no store */ }
    }

    setContext(ompCtx)

    const invocationId = createInvocationId()

    // --- Abort check ---
    if (signal?.aborted) {
      const base: CreateEnvelopeOpts = {
        tool_id: TOOL_ID,
        tool_version: VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: true,
        read_paths: [],
        written_paths: [],
        denied_paths: [],
        policy_reasons: [],
      }
      return wrap(
        createEnvelope({
          ...base,
          status: "error",
          error: toolError("INTERNAL_ERROR", "Execution was aborted before work began"),
        }),
        params,
      )
    }

    onUpdate?.({
      content: [{ type: "text", text: `Preparing text replace for ${params.file}...` }],
      details: { phase: "validate" },
    })

    // --- Build _lib schema input and validate ---
    const replaceInput: TextReplaceInputV1 = {
      path: params.file,
      expected_before_sha256: params.expected_before_sha256 ?? "",
      old_text: params.old,
      new_text: params.new,
      replace_mode: "exact_once",
      reason: params.reason,
    }
    const validated = validateTextReplaceInput(replaceInput)
    if (!validated.ok) {
      const base: CreateEnvelopeOpts = {
        tool_id: TOOL_ID,
        tool_version: VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: true,
        read_paths: [],
        written_paths: [],
        denied_paths: [],
        policy_reasons: [],
      }
      return wrap(
        createEnvelope({
          ...base,
          status: "error",
          error: toolError("INVALID_INPUT", validated.error),
        }),
        params,
      )
    }

    // --- Resolve write path ---
    const decision = resolveWritePath(params.file, ompCtx)
    if (!decision.ok) {
      const base: CreateEnvelopeOpts = {
        tool_id: TOOL_ID,
        tool_version: VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: true,
        read_paths: [],
        written_paths: [],
        denied_paths: [],
        policy_reasons: [],
      }
      return wrap(
        createEnvelope({
          ...base,
          status: "refused",
          denied_paths: [params.file],
          policy_reasons: [decision.reason ?? "Path denied by policy"],
          error: toolError("PATH_DENIED", decision.reason ?? "Path denied by policy"),
        }),
        params,
      )
    }

    const resolvedPath = decision.absolute_path!
    const relativePath = decision.normalized_path!
    // --- Acquire path lock before mutation ---
    let lockIds: string[] | undefined
    if (store) {
      const lockResult = await store.acquirePathLocks({
        paths: [{ path: relativePath, lock_kind: "write" }],
        session_id: sessionId,
      })
      if (!lockResult.acquired) {
        return wrap(createEnvelope({
          tool_id: TOOL_ID, tool_version: VERSION, invocation_id: invocationId,
          started_at: startedAt, status: "refused", risk_level: RISK_LEVEL,
          requires_approval: false, requires_hash_precondition: true,
          error: toolError("PATH_LOCK_CONFLICT", `Path is locked by another session: ${relativePath}`, {
            details: lockResult.conflicts, retryable: true
          }),
          denied_paths: [relativePath],
          policy_reasons: ["PATH_LOCK_CONFLICT"],
        }), params)
      }
      lockIds = lockResult.lock_ids
    }

    try {

    // --- Read file ---
    let original: string
    try {
      original = readFileSync(resolvedPath, "utf8")
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      const base: CreateEnvelopeOpts = {
        tool_id: TOOL_ID,
        tool_version: VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: true,
        read_paths: [],
        written_paths: [],
        denied_paths: [],
        policy_reasons: [],
      }
      return wrap(
        createEnvelope({
          ...base,
          status: "error",
          read_paths: [relativePath],
          error: toolError("PATH_NOT_FOUND", `Cannot read ${relativePath}: ${msg}`),
        }),
        params,
      )
    }

    const beforeHash = sha256(original)

    // --- Hash precondition ---
    let hashPreconditionSatisfied = true
    if (!params.expected_before_sha256) {
      // expected_before_sha256 is REQUIRED — refuse unless allow_unverified_write
      if (!params.allow_unverified_write) {
        const base: CreateEnvelopeOpts = {
          tool_id: TOOL_ID,
          tool_version: VERSION,
          invocation_id: invocationId,
          started_at: startedAt,
          risk_level: RISK_LEVEL,
          requires_approval: false,
          requires_hash_precondition: true,
          read_paths: [],
          written_paths: [],
          denied_paths: [],
          policy_reasons: [],
        }
        return wrap(
          createEnvelope({
            ...base,
            status: "error",
            read_paths: [relativePath],
            error: toolError(
              "HASH_MISMATCH",
              "expected_before_sha256 is required when allow_unverified_write is false. " +
                "Set allow_unverified_write=true to bypass, or provide the current file hash.",
            ),
          }),
          params,
        )
      }
      // allow_unverified_write is true — warn and proceed
      hashPreconditionSatisfied = false
    } else if (beforeHash !== params.expected_before_sha256) {
      const base: CreateEnvelopeOpts = {
        tool_id: TOOL_ID,
        tool_version: VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: true,
        read_paths: [],
        written_paths: [],
        denied_paths: [],
        policy_reasons: [],
      }
      return wrap(
        createEnvelope({
          ...base,
          status: "error",
          read_paths: [relativePath],
          error: toolError(
            "HASH_MISMATCH",
            `Stale hash: expected ${params.expected_before_sha256} but file has ${beforeHash}. ` +
              "The file was modified since the expected hash was computed. Re-read the file to get current content and hash.",
          ),
        }),
        params,
      )
    }

    // --- Match count check ---
    const matchCount = original.split(params.old).length - 1

    if (matchCount === 0) {
      // Idempotent mode: if new text already present exactly once, skip
      if (params.idempotent) {
        const newCount = original.split(params.new).length - 1
        if (newCount === 1) {
          const afterHash = beforeHash
          const inputSha256 = sha256Json(params)
          const normalizedInputSha256 = sha256Json(replaceInput)
          const receiptId = createReceiptId(
            TOOL_ID,
            ompCtx.actor.session_id ?? "unknown",
            [relativePath],
            beforeHash,
            afterHash,
          )
          const receiptPath = allocateReceiptPath(receiptId, ompCtx)

          // Build receipt for the skip case
          const receipt = buildReceipt({
            receipt_id: receiptId,
            invocation_id: invocationId,
            tool_id: TOOL_ID,
            tool_version: VERSION,
            ctx: ompCtx,
            input_sha256: inputSha256,
            normalized_input_sha256: normalizedInputSha256,
            files: [
              {
                path: relativePath,
                action: "read",
                before_sha256: beforeHash,
                after_sha256: afterHash,
              },
            ],
            summary: `Skipped: ${relativePath} — replacement text already present`,
            diff_paths: [],
            hash_precondition_satisfied: hashPreconditionSatisfied,
            receipt_path: receiptPath,
          })
          writeReceipt(receipt, receiptPath)

          // Append audit event
          const eventId = createEventId()
          const event: OmpToolEventV1 = {
            schema: "omp.tool.event.v1",
            event_id: eventId,
            timestamp: new Date().toISOString(),
            invocation_id: invocationId,
            receipt_id: receiptId,
            tool_id: TOOL_ID,
            tool_version: VERSION,
            status: "ok",
            risk_level: RISK_LEVEL,
            paths: {
              read: [relativePath],
              written: [],
              denied: [],
            },
            input_sha256: inputSha256,
            receipt_path: receiptPath,
          }
          appendAuditEvent(ompCtx, event)

          const base: CreateEnvelopeOpts = {
            tool_id: TOOL_ID,
            tool_version: VERSION,
            invocation_id: invocationId,
            started_at: startedAt,
            risk_level: RISK_LEVEL,
            requires_approval: false,
            requires_hash_precondition: true,
            read_paths: [],
            written_paths: [],
            denied_paths: [],
            policy_reasons: [],
          }
          return wrap(
            createEnvelope({
              ...base,
              status: "ok",
              receipt_id: receiptId,
              read_paths: [relativePath],
              result: {
                path: relativePath,
                before_sha256: beforeHash,
                after_sha256: afterHash,
                changed: false,
                skipped: true,
                note: "Replacement text already present — no change needed.",
              },
              evidence: {
                receipt_path: receiptPath,
                event_path: ompCtx.paths.events_path,
                before_hashes: { [relativePath]: beforeHash },
                after_hashes: { [relativePath]: afterHash },
              },
            }),
            params,
          )
        }
      }

      // Refuse: old text not found
      const base: CreateEnvelopeOpts = {
        tool_id: TOOL_ID,
        tool_version: VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: true,
        read_paths: [],
        written_paths: [],
        denied_paths: [],
        policy_reasons: [],
      }
      return wrap(
        createEnvelope({
          ...base,
          status: "error",
          read_paths: [relativePath],
          error: toolError(
            "MATCH_NOT_FOUND",
            `old text not found in ${relativePath}. Use struct_read to inspect the file and verify exact content including whitespace.`,
          ),
        }),
        params,
      )
    }

    if (matchCount > 1) {
      const base: CreateEnvelopeOpts = {
        tool_id: TOOL_ID,
        tool_version: VERSION,
        invocation_id: invocationId,
        started_at: startedAt,
        risk_level: RISK_LEVEL,
        requires_approval: false,
        requires_hash_precondition: true,
        read_paths: [],
        written_paths: [],
        denied_paths: [],
        policy_reasons: [],
      }
      return wrap(
        createEnvelope({
          ...base,
          status: "error",
          read_paths: [relativePath],
          error: toolError(
            "MATCH_NOT_UNIQUE",
            `Text matches ${matchCount} times in ${relativePath} — must be unique. ` +
              "Use a larger old string that captures enough surrounding context to be unambiguous.",
          ),
        }),
        params,
      )
    }

    // --- Apply replacement ---
    onUpdate?.({
      content: [{ type: "text", text: `Applying replacement to ${relativePath}...` }],
      details: { phase: "apply" },
    })

    const afterContent = original.replace(params.old, params.new)
    writeFileSync(resolvedPath, afterContent, "utf8")
    const afterHash = sha256(afterContent)

    // --- Write diff artifact ---
    const diffArtifact = writeDiffArtifact(invocationId, relativePath, original, afterContent, ompCtx)

    // --- Compute input hashes ---
    const inputSha256 = sha256Json(params)
    const normalizedInputSha256 = sha256Json(replaceInput)

    // --- Create receipt IDs ---
    const receiptId = createReceiptId(
      TOOL_ID,
      ompCtx.actor.session_id ?? "unknown",
      [relativePath],
      beforeHash,
      afterHash,
    )
    const receiptPath = allocateReceiptPath(receiptId, ompCtx)

    // --- Build and write receipt ---
    const receipt = buildReceipt({
      receipt_id: receiptId,
      invocation_id: invocationId,
      tool_id: TOOL_ID,
      tool_version: VERSION,
      ctx: ompCtx,
      input_sha256: inputSha256,
      normalized_input_sha256: normalizedInputSha256,
      files: [
        {
          path: relativePath,
          action: "write",
          before_sha256: beforeHash,
          expected_before_sha256: params.expected_before_sha256,
          after_sha256: afterHash,
          before_size_bytes: original.length,
          after_size_bytes: afterContent.length,
          diff_path: diffArtifact.diff_path,
        },
      ],
      summary: `Replaced text in ${relativePath} (${beforeHash.slice(0, 8)} → ${afterHash.slice(0, 8)})`,
      diff_paths: [diffArtifact.diff_path],
      hash_precondition_satisfied: hashPreconditionSatisfied,
      receipt_path: receiptPath,
    })
    writeReceipt(receipt, receiptPath)

    // --- Append audit event ---
    const eventId = createEventId()
    const event: OmpToolEventV1 = {
      schema: "omp.tool.event.v1",
      event_id: eventId,
      timestamp: new Date().toISOString(),
      invocation_id: invocationId,
      receipt_id: receiptId,
      tool_id: TOOL_ID,
      tool_version: VERSION,
      status: "ok",
      risk_level: RISK_LEVEL,
      paths: {
        read: [relativePath],
        written: [relativePath],
        denied: [],
      },
      input_sha256: inputSha256,
      diff_paths: [diffArtifact.diff_path],
      receipt_path: receiptPath,
    }
    appendAuditEvent(ompCtx, event)

    // --- Build onUpdate ---
    onUpdate?.({
      content: [
        {
          type: "text",
          text: `Replaced in ${relativePath} (${beforeHash.slice(0, 8)} → ${afterHash.slice(0, 8)})\nReceipt: ${receiptId}`,
        },
      ],
      details: { status: "ok", receipt_id: receiptId, receipt_path: receiptPath },
    })

    // --- Record mutation in PGlite ---
    if (store) {
      await store.recordInvocationWithMutations({
        invocation: {
          invocation_id: invocationId,
          session_id: sessionId,
          tool_id: TOOL_ID,
          tool_version: VERSION,
          status: "ok",
          risk_level: RISK_LEVEL,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - new Date(startedAt).getTime(),
          input_sha256: sha256(JSON.stringify(params)),
          output_sha256: sha256(afterContent),
          receipt_id: receiptId,
        },
        mutations: [
          {
            invocation_id: invocationId,
            session_id: sessionId,
            receipt_id: receiptId,
            path: relativePath,
            action: "write",
            before_sha256: beforeHash,
            expected_before_sha256: params.expected_before_sha256,
            after_sha256: afterHash,
            before_size_bytes: Buffer.byteLength(original, "utf-8"),
            after_size_bytes: Buffer.byteLength(afterContent, "utf-8"),
            diff_path: diffArtifact.diff_path,
            diff_sha256: diffArtifact.diff_sha256,
          },
        ],
      })
    }

    // --- Return envelope ---
    const base: CreateEnvelopeOpts = {
      tool_id: TOOL_ID,
      tool_version: VERSION,
      invocation_id: invocationId,
      started_at: startedAt,
      risk_level: RISK_LEVEL,
      requires_approval: false,
      requires_hash_precondition: true,
      read_paths: [],
      written_paths: [],
      denied_paths: [],
      policy_reasons: [],
    }
    return wrap(
      createEnvelope({
        ...base,
        status: "ok",
        receipt_id: receiptId,
        read_paths: [relativePath],
        written_paths: [relativePath],
        result: {
          path: relativePath,
          before_sha256: beforeHash,
          after_sha256: afterHash,
          changed: beforeHash !== afterHash,
          line_ranges: computeLineRange(original, params.old),
          diff_path: diffArtifact.diff_path,
        },
        evidence: {
          receipt_path: receiptPath,
          diff_paths: [diffArtifact.diff_path],
          event_path: ompCtx.paths.events_path,
          before_hashes: { [relativePath]: beforeHash },
          after_hashes: { [relativePath]: afterHash },
        },
      }),
      params,
    )
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e)
      if (store) {
        await store.recordInvocation({
          invocation_id: invocationId,
          session_id: sessionId,
          tool_id: TOOL_ID,
          tool_version: VERSION,
          status: "error",
          risk_level: RISK_LEVEL,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - new Date(startedAt).getTime(),
          input_sha256: sha256(JSON.stringify(params)),
          output_sha256: "",
          error_code: "INTERNAL_ERROR",
          error_message: errMsg,
        })
      }
      return wrap(
        createEnvelope({
          tool_id: TOOL_ID,
          tool_version: VERSION,
          invocation_id: invocationId,
          started_at: startedAt,
          status: "error",
          risk_level: RISK_LEVEL,
          requires_approval: false,
          requires_hash_precondition: true,
          error: toolError("INTERNAL_ERROR", errMsg),
        }),
        params,
      )
    } finally {
      if (store && lockIds) {
        try { await store.releasePathLocks({ lock_ids: lockIds, session_id: sessionId }) } catch {}
      }
    }
  },
})

function computeLineRange(content: string, searchText: string): { start_line: number; end_line: number } {
  const lines = content.split("\n")
  const firstSearchLine = searchText.split("\n")[0]
  if (!firstSearchLine) return { start_line: 1, end_line: 1 }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(firstSearchLine.trim())) {
      return {
        start_line: i + 1,
        end_line: i + searchText.split("\n").length,
      }
    }
  }
  return { start_line: 1, end_line: 1 }
}

function wrap(
  envelope: OmpToolEnvelopeV1,
  params: { file: string; old: string; new: string; reason: string },
): { content: Array<{ type: "text"; text: string }>; details: OmpToolEnvelopeV1 } {
  const status = envelope.status
  let text: string

  if (status === "ok") {
    const result = isRecord(envelope.result) ? envelope.result : undefined
    const filePath = envelope.paths.written[0] ?? envelope.paths.read[0] ?? params.file
    const skipped = isRecord(result) && result.skipped === true

    if (skipped) {
      text = `Skipped: ${filePath} — replacement text already present.\nReason: ${params.reason}`
    } else {
      const before =
        isRecord(result) && typeof result.before_sha256 === "string" ? result.before_sha256 : ""
      const after =
        isRecord(result) && typeof result.after_sha256 === "string" ? result.after_sha256 : ""
      const beforeShort = before.slice(0, 8)
      const afterShort = after.slice(0, 8)
      const receiptId = envelope.receipt_id ?? ""
      text = [
        `Replaced in ${filePath} (${beforeShort} → ${afterShort})`,
        `Reason: ${params.reason}`,
        `- ${params.old.slice(0, 100)}`,
        `+ ${params.new.slice(0, 100)}`,
        `Receipt: ${receiptId}`,
      ].join("\n")
    }
  } else if (status === "error" || status === "refused") {
    const err = envelope.error
    const code = err?.code ?? "UNKNOWN"
    const message = err?.message ?? "Unknown error"
    text = status === "refused" ? `Refused: ${code}: ${message}` : `Error: ${code}: ${message}`
  } else {
    text = `${status}: ${envelope.error?.message ?? "Unknown error"}`
  }

  return {
    content: [{ type: "text", text }],
    details: envelope,
  }
}

export default factory
