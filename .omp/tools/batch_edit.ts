import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"

import { readFileSync, writeFileSync } from "node:fs"

import { sha256 } from "./_lib/hashing.js"
import { setContext, createEnvelope } from "./_lib/envelope.js"
import { resolveWritePath } from "./_lib/path-policy.js"
import { buildToolContext } from "./_lib/tool-context.js"
import { allocateReceiptPath, buildReceipt, writeReceipt, writeDiffArtifact, writeCombinedDiffArtifact } from "./_lib/receipts.js"
import { appendAuditEvent } from "./_lib/audit.js"
import { createInvocationId, createReceiptId, createEventId, createJournalId } from "./_lib/ids.js"
import { toolError } from "./_lib/errors.js"
import { validateBatchEditInput } from "./_lib/schemas.js"
import { getPgliteStore } from "./_lib/store/pglite-store.js"
import type { OmpRelationalStoreV1, WriteJournalRecordV1, ToolInvocationRecordV1, RecordMutationInputV1 } from "./_lib/store/pglite-types.js"
import type { BatchEditInputV1, BatchEditFileV1 } from "./_lib/schemas.js"
import type { OmpToolContextV1, OmpToolEnvelopeV1, OmpToolReceiptV1, OmpErrorCodeV1, OmpToolEventV1 } from "./_lib/types.js"

const TOOL_ID = "batch_edit"
const TOOL_VERSION = "1.0.0"
const RISK_LEVEL = "write_high"


type FileEditGroup = {
  file: BatchEditFileV1
  resolvedPath: string
  normalizedPath: string
}

type FileState = {
  group: FileEditGroup
  before: string
  beforeHash: string
  beforeSize: number
  after: string
  afterHash: string
  afterSize: number
  diffPaths: string[]
}

const factory: CustomToolFactory = (pi) => ({
  name: "batch_edit",
  label: "Batch Edit",
  description:
    "Apply multiple text replacements across multiple files as a single validated batch. Validates the full batch before writing. If validation fails, no files are written.",

  parameters: pi.zod.object({
    edits: pi.zod
      .string()
      .describe(
        'JSON string of {files: [{path, expected_before_sha256, edits: [{kind: "replace_exact_once", old_text, new_text}]}], reason?, allow_unverified_write?}. All edits validated before any applied. Edits to same file compose correctly on an evolving buffer.',
      ),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    const startedAt = new Date().toISOString()
    const invocationId = createInvocationId()
    const sessionId = ctx?.sessionId ?? "unknown"

    // ── Build tool context first (needed for error envelopes) ──
    const toolCtx = buildToolContext({
      cwd: pi.cwd,
      repoRoot: pi.cwd,
      mode: "loose",
      actor: ctx?.sessionId
        ? { kind: "agent", session_id: ctx.sessionId }
        : { kind: "unknown" },
      sessionId,
    })
    setContext(toolCtx)

    // ── Initialize store (optional — fall back to loose mode) ──
    let store: OmpRelationalStoreV1 | undefined
    let lockIds: string[] | undefined
    try {
      store = getPgliteStore({ repoRoot: pi.cwd })
    } catch {
      store = undefined
    }
    if (store) {
      try { toolCtx.store = store } catch {}
    }

    // ── Parse JSON input ──
    let parsed: unknown
    try {
      parsed = JSON.parse(params.edits)
    } catch {
      return earlyError("INVALID_JSON", "Failed to parse 'edits' as JSON.", { invocationId, startedAt })
    }

    // ── Validate shape via schema validator ──
    const validated = validateBatchEditInput(parsed)
    if (!validated.ok) {
      return earlyError("INVALID_INPUT", validated.error, { invocationId, startedAt })
    }
    const input: BatchEditInputV1 = validated.value

    if (input.files.length === 0) {
      return earlyError("INVALID_INPUT", "files array must not be empty.", { invocationId, startedAt })
    }

    // ── Phase 1: Resolve all write paths ──
    const groups: FileEditGroup[] = []
    const deniedPaths: string[] = []
    const policyReasons: string[] = []

    for (const file of input.files) {
      const decision = resolveWritePath(file.path, toolCtx)
      if (!decision.ok) {
        deniedPaths.push(file.path)
        policyReasons.push(decision.reason ?? "denied by path policy")
      } else {
        groups.push({
          file,
          resolvedPath: decision.absolute_path!,
          normalizedPath: decision.normalized_path!,
        })
      }
    }

    if (deniedPaths.length > 0) {
      return errorResult({
        invocationId,
        startedAt,
        code: "PATH_DENIED",
        message: `Path policy denied ${deniedPaths.length} file(s): ${deniedPaths.join(", ")}`,
        details: { denied: deniedPaths, reasons: policyReasons },
        readPaths: [],
        writtenPaths: [],
        deniedPaths,
        policyReasons,
        toolCtx,
      })
    }

    onUpdate?.({
      content: [{ type: "text", text: `Resolved ${groups.length} file(s) — validating...` }],
      details: { phase: "validate", fileCount: groups.length },
    })

    if (signal?.aborted) {
      return earlyError("INTERNAL_ERROR", "Execution cancelled.", { invocationId, startedAt })
    }

    // ── Phase 1.5: Acquire all path locks (sorted by path for deadlock prevention) ──
    const sortedGroups = groups.slice().sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath))

    if (store) {
      const lockInputs = sortedGroups.map((g) => ({ path: g.normalizedPath, lock_kind: "write" as const }))
      const lockResult = await store.acquirePathLocks({
        paths: lockInputs,
        session_id: sessionId,
      })
      if (!lockResult.acquired) {
        const conflictPaths = (lockResult.conflicts ?? []).map((c) => c.path)
        return formatReturn(
          createEnvelope({
            tool_id: TOOL_ID,
            tool_version: TOOL_VERSION,
            invocation_id: invocationId,
            started_at: startedAt,
            status: "refused",
            risk_level: RISK_LEVEL,
            requires_approval: false,
            requires_hash_precondition: true,
            error: toolError("PATH_LOCK_CONFLICT", `Path lock conflict on ${conflictPaths.length} file(s): ${conflictPaths.join(", ")}`, {
              details: { conflicts: lockResult.conflicts },
              retryable: true,
            }),
            read_paths: [],
            written_paths: [],
            denied_paths: [],
            policy_reasons: [],
          }),
          input,
        )
      }
      lockIds = lockResult.lock_ids
    }

    try {

    // ── Phase 2: Read files, verify hashes, verify match uniqueness (after locks acquired) ──
    const fileStates = new Map<string, FileState>()
    const readPaths: string[] = []

    for (const group of groups) {
      let before: string
      try {
        before = readFileSync(group.resolvedPath, "utf8")
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return errorResult({
          invocationId,
          startedAt,
          code: "PATH_NOT_FOUND",
          message: `Cannot read ${group.normalizedPath}: ${msg}`,
          readPaths,
          writtenPaths: [],
          deniedPaths: [],
          toolCtx,
        })
      }

      readPaths.push(group.normalizedPath)
      const beforeHash = sha256(before)
      const beforeSize = Buffer.byteLength(before, "utf8")

      // ── Hash is REQUIRED per file ──
      const expectedHash = group.file.expected_before_sha256
      if (!expectedHash) {
        return errorResult({
          invocationId,
          startedAt,
          code: "HASH_MISMATCH",
          message: `expected_before_sha256 is required for ${group.normalizedPath}`,
          readPaths,
          writtenPaths: [],
          deniedPaths: [],
          toolCtx,
        })
      }

      if (beforeHash !== expectedHash) {
        if (input.allow_unverified_write) {
          // Warn but proceed — hash_precondition_satisfied will be false
          onUpdate?.({
            content: [{ type: "text", text: `Hash mismatch on ${group.normalizedPath} — allowing per allow_unverified_write` }],
            details: { phase: "warning", file: group.normalizedPath, expected: expectedHash, actual: beforeHash },
          })
        } else {
          return errorResult({
            invocationId,
            startedAt,
            code: "HASH_MISMATCH",
            message: `Stale hash for ${group.normalizedPath}: expected ${expectedHash}, actual ${beforeHash}`,
            readPaths,
            writtenPaths: [],
            deniedPaths: [],
            policyReasons: [],
            toolCtx,
          })
        }
      }

      // ── Verify each edit matches exactly once on the original content ──
      // We check against the original content first, and also track evolving buffer
      let buffer = before
      for (let ei = 0; ei < group.file.edits.length; ei++) {
        const ed = group.file.edits[ei]!

        const count = buffer.split(ed.old_text).length - 1
        if (count === 0) {
          return errorResult({
            invocationId,
            startedAt,
            code: "MATCH_NOT_FOUND",
            message: `Edit #${ei} on ${group.normalizedPath}: old_text not found`,
            details: { file: group.normalizedPath, editIndex: ei },
            readPaths,
            writtenPaths: [],
            deniedPaths: [],
            toolCtx,
          })
        }
        if (count > 1) {
          return errorResult({
            invocationId,
            startedAt,
            code: "MATCH_NOT_UNIQUE",
            message: `Edit #${ei} on ${group.normalizedPath}: old_text matches ${count} times (must be exactly 1)`,
            details: { file: group.normalizedPath, editIndex: ei, matchCount: count },
            readPaths,
            writtenPaths: [],
            deniedPaths: [],
            toolCtx,
          })
        }

        // Apply to evolving buffer for subsequent edits on same file
        buffer = buffer.replace(ed.old_text, ed.new_text)
      }

      // Final after state (all edits composed)
      const after = buffer
      const afterHash = sha256(after)
      const afterSize = Buffer.byteLength(after, "utf8")

      fileStates.set(group.normalizedPath, {
        group,
        before,
        beforeHash,
        beforeSize,
        after,
        afterHash,
        afterSize,
        diffPaths: [],
      })
    }

    // ── Create receiptId (moved before writes for journal reference) ──
    const receiptId = createReceiptId(
      TOOL_ID,
      sessionId,
      [...fileStates.keys()],
      sha256([...fileStates.values()].map((s) => s.beforeHash).join("|")),
      sha256([...fileStates.values()].map((s) => s.afterHash).join("|")),
    )

    // ── Create write journal (prepared) ──
    let journalId: string | undefined
    if (store) {
      journalId = createJournalId(receiptId)
      const journal: WriteJournalRecordV1 = {
        journal_id: journalId,
        receipt_id: receiptId,
        invocation_id: invocationId,
        session_id: sessionId,
        status: "prepared",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        journal_path: `${toolCtx.paths.journals_dir}/journal_${journalId}.json`,
      }
      try {
        await store.createWriteJournal(journal)
      } catch {
        // Non-fatal — fall back to loose mode
      }
    }

    // ── Phase 3: Write all files ──
    onUpdate?.({
      content: [{ type: "text", text: `Writing ${fileStates.size} file(s)...` }],
      details: { phase: "write" },
    })

    let writeError: Error | undefined
    const writtenPaths: string[] = []

    try {
      for (const [normalizedPath, state] of fileStates) {
        writeFileSync(state.group.resolvedPath, state.after, "utf8")
        writtenPaths.push(normalizedPath)
      }
    } catch (e: unknown) {
      writeError = e instanceof Error ? e : new Error(String(e))
    }

    if (writeError) {
      // Mark journal as rollback_needed
      if (store && journalId) {
        try {
          await store.updateWriteJournalStatus({ journal_id: journalId, status: "rollback_needed" })
        } catch {}
      }
      return errorResult({
        invocationId,
        startedAt,
        code: "WRITE_FAILED",
        message: `Write failed: ${writeError.message}`,
        readPaths,
        writtenPaths,
        deniedPaths: [],
        toolCtx,
      })
    }

    // ── Phase 4: Write diffs ──
    // Per-file diffs
    const perFileDiffs: Array<{ file_path: string; before: string; after: string }> = []
    for (const [normalizedPath, state] of fileStates) {
      const { diff_path } = writeDiffArtifact(receiptId, normalizedPath, state.before, state.after, toolCtx)
      state.diffPaths.push(diff_path)
      perFileDiffs.push({ file_path: normalizedPath, before: state.before, after: state.after })
    }

    // Combined diff
    const { diff_path: combinedDiffPath } = writeCombinedDiffArtifact(
      receiptId,
      perFileDiffs,
      toolCtx,
    )

    const allDiffPaths: string[] = [...fileStates.values()].flatMap((s) => s.diffPaths)
    allDiffPaths.push(combinedDiffPath)

    // ── Mark journal committed ──
    if (store && journalId) {
      try {
        await store.updateWriteJournalStatus({ journal_id: journalId, status: "committed" })
      } catch {
        // Non-fatal — user data is on disk; journal is advisory
      }
    }

    // ── Phase 5: Build and write receipt ──
    const receiptPath = allocateReceiptPath(receiptId, toolCtx)
    const hashPreconditionSatisfied = (() => {
      // True if every file's hash matched, or if allow_unverified_write was set to proceed despite mismatches
      if (input.allow_unverified_write) return false
      for (const [, state] of fileStates) {
        const expected = state.group.file.expected_before_sha256
        if (expected && state.beforeHash !== expected) return false
      }
      return true
    })()

    const receiptFiles: OmpToolReceiptV1["files"] = [...fileStates].map(([normalizedPath, state]) => ({
      path: normalizedPath,
      action: "write" as const,
      before_sha256: state.beforeHash,
      expected_before_sha256: state.group.file.expected_before_sha256,
      after_sha256: state.afterHash,
      before_size_bytes: state.beforeSize,
      after_size_bytes: state.afterSize,
      diff_path: state.diffPaths[0],
    }))

    const receipt = buildReceipt({
      receipt_id: receiptId,
      invocation_id: invocationId,
      tool_id: TOOL_ID,
      tool_version: TOOL_VERSION,
      ctx: toolCtx,
      input_sha256: sha256(JSON.stringify(input)),
      normalized_input_sha256: sha256(JSON.stringify(input)),
      input_redacted_preview: { reason: input.reason, fileCount: input.files.length },
      files: receiptFiles,
      summary: `Applied ${input.files.reduce((s, f) => s + f.edits.length, 0)} edit(s) across ${fileStates.size} file(s)`,
      diff_paths: allDiffPaths,
      hash_precondition_satisfied: hashPreconditionSatisfied,
      receipt_path: receiptPath,
    })

    writeReceipt(receipt, receiptPath)

    // ── Phase 6: Record mutations + invocation in PGlite ──
    if (store) {
      const mutations: RecordMutationInputV1[] = []
      for (const [normalizedPath, state] of fileStates) {
        mutations.push({
          invocation_id: invocationId,
          session_id: sessionId,
          receipt_id: receiptId,
          path: normalizedPath,
          action: "write",
          before_sha256: state.beforeHash,
          expected_before_sha256: state.group.file.expected_before_sha256,
          after_sha256: state.afterHash,
          before_size_bytes: state.beforeSize,
          after_size_bytes: state.afterSize,
          diff_path: state.diffPaths[0],
        })
      }

      const finishedAt = new Date()
      const durationMs = finishedAt.getTime() - new Date(startedAt).getTime()
      const invocation: ToolInvocationRecordV1 = {
        invocation_id: invocationId,
        session_id: sessionId,
        tool_id: TOOL_ID,
        tool_version: TOOL_VERSION,
        status: "ok",
        risk_level: RISK_LEVEL,
        started_at: startedAt,
        finished_at: finishedAt.toISOString(),
        duration_ms: durationMs,
        input_sha256: sha256(JSON.stringify(input)),
        receipt_id: receiptId,
      }
      try {
        await store.recordInvocationWithMutations({ invocation, mutations })
      } catch {
        // Non-fatal
      }
    }

    // ── Phase 7: Audit event ──
    const eventId = createEventId()
    const beforeHashes: Record<string, string> = {}
    const afterHashes: Record<string, string> = {}
    for (const [normalizedPath, state] of fileStates) {
      beforeHashes[normalizedPath] = state.beforeHash
      afterHashes[normalizedPath] = state.afterHash
    }

    const event: OmpToolEventV1 = {
      schema: "omp.tool.event.v1",
      event_id: eventId,
      timestamp: new Date().toISOString(),
      invocation_id: invocationId,
      receipt_id: receiptId,
      tool_id: TOOL_ID,
      tool_version: TOOL_VERSION,
      status: "ok",
      risk_level: RISK_LEVEL,
      paths: {
        read: readPaths,
        written: writtenPaths,
        denied: [],
      },
      input_sha256: sha256(JSON.stringify(input)),
      receipt_path: receiptPath,
      diff_paths: allDiffPaths,
    }

    appendAuditEvent(toolCtx, event)

    // ── Phase 8: Build and return envelope ──
    const totalEdits = input.files.reduce((s, f) => s + f.edits.length, 0)
    const envelopeResult = {
      changed_files: writtenPaths,
      receipt_id: receiptId,
      diff_paths: allDiffPaths,
      edit_count: totalEdits,
      file_count: fileStates.size,
      hash_precondition_satisfied: hashPreconditionSatisfied,
    }

    const envelope = createEnvelope({
      tool_id: TOOL_ID,
      tool_version: TOOL_VERSION,
      invocation_id: invocationId,
      started_at: startedAt,
      receipt_id: receiptId,
      status: "ok",
      risk_level: RISK_LEVEL,
      requires_approval: false,
      requires_hash_precondition: true,
      result: envelopeResult,
      evidence: {
        receipt_path: receiptPath,
        diff_paths: allDiffPaths,
        event_path: toolCtx.paths.events_path,
        before_hashes: beforeHashes,
        after_hashes: afterHashes,
      },
      read_paths: readPaths,
      written_paths: writtenPaths,
      denied_paths: deniedPaths,
      policy_reasons: policyReasons,
    })

    onUpdate?.({
      content: [{
        type: "text",
        text: `Applied ${totalEdits} edit(s) across ${fileStates.size} file(s)\nReceipt: ${receiptId}`,
      }],
      details: { status: "ok", receiptId, receiptPath },
    })

    return formatReturn(envelope, input)
  } finally {
    if (store && lockIds) {
      try { await store.releasePathLocks({ lock_ids: lockIds, session_id: sessionId }) } catch {}
    }
  }
  },
})

// ── Helpers ──

function formatReturn(
  envelope: OmpToolEnvelopeV1,
  input: BatchEditInputV1,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
  const status = envelope.status

  let text: string
  if (status === "ok") {
    const r = envelope.result as Record<string, unknown> | undefined
    const fileCount = r?.file_count ?? 0
    const editCount = r?.edit_count ?? 0
    const rid = r?.receipt_id ?? ""
    const precondition = r?.hash_precondition_satisfied
      ? ""
      : " (hash precondition NOT satisfied — allow_unverified_write was set)"
    text = `Applied ${editCount} edit(s) across ${fileCount} file(s). Receipt: ${rid}${precondition}`
  } else if (status === "error" || status === "refused") {
    const err = envelope.error
    const msg = err ? `${err.code}: ${err.message}` : "Unknown error"
    text = `Batch edit ${status}: ${msg}`
  } else {
    text = `${status}: unexpected status`
  }

  return {
    content: [{ type: "text", text }],
    details: envelope satisfies Record<string, unknown>,
  }
}

type ErrorOpts = {
  invocationId: string
  startedAt: string
  code: OmpErrorCodeV1
  message: string
  details?: unknown
  readPaths: string[]
  writtenPaths: string[]
  deniedPaths: string[]
  policyReasons?: string[]
  toolCtx: OmpToolContextV1
}

function errorResult(opts: ErrorOpts): {
  content: { type: "text"; text: string }[]
  details: Record<string, unknown>
} {
  const err = toolError(opts.code, opts.message, { details: opts.details, retryable: false })
  const envelope = createEnvelope({
    tool_id: TOOL_ID,
    tool_version: TOOL_VERSION,
    invocation_id: opts.invocationId,
    started_at: opts.startedAt,
    status: "refused",
    risk_level: RISK_LEVEL,
    requires_approval: false,
    requires_hash_precondition: true,
    error: err,
    read_paths: opts.readPaths,
    written_paths: opts.writtenPaths,
    denied_paths: opts.deniedPaths,
    policy_reasons: opts.policyReasons ?? [],
  })

  return {
    content: [{ type: "text", text: `Batch edit refused: ${opts.code}: ${opts.message}` }],
    details: envelope satisfies Record<string, unknown>,
  }
}

function earlyError(
  code: OmpErrorCodeV1,
  message: string,
  meta: { invocationId: string; startedAt: string },
): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
  const err = toolError(code, message)
  const envelope = createEnvelope({
    tool_id: TOOL_ID,
    tool_version: TOOL_VERSION,
    invocation_id: meta.invocationId,
    started_at: meta.startedAt,
    status: "refused",
    risk_level: RISK_LEVEL,
    requires_approval: false,
    requires_hash_precondition: true,
    error: err,
    read_paths: [],
    written_paths: [],
    denied_paths: [],
    policy_reasons: [],
  })

  return {
    content: [{ type: "text", text: `Batch edit refused: ${code}: ${message}` }],
    details: envelope satisfies Record<string, unknown>,
  }
}

export default factory
