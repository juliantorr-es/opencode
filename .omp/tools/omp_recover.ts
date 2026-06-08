import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getPgliteStore } from "./_lib/store/index.js";

const TOOL_ID = "omp_recover";
const TOOL_VERSION = "1.0.0";
const RISK_LEVEL = "read" as const;

// ── Helper: open a lightweight PGlite connection for read-only queries ──
async function openPgliteForQuery(repoRoot: string): Promise<{ db: import("@electric-sql/pglite").PGlite } | { db: null }> {
  try {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = resolve(repoRoot, ".omp/state/pglite");
    if (!existsSync(dir)) return { db: null };
    const db = new PGlite(dir);
    return { db };
  } catch {
    return { db: null };
  }
}

const factory: CustomToolFactory = (pi) => ({
  name: TOOL_ID,
  label: "OMP Recover",
  description:
    "Inspect the PGlite coordination store for expired sessions, stale locks, pending journals, missing receipt/diff artifacts, and orphaned rows. Report mode calls abandonExpiredSessions() to clean up stale sessions and locks. Repair mode is report-only in v1 and suggests manual actions.",

  parameters: pi.zod.object({
    mode: pi.zod
      .enum(["report", "repair"])
      .optional()
      .default("report")
      .describe("'report' inspects and cleans up expired sessions/locks; 'repair' suggests actions without auto-repairing"),
  }),

  async execute(_toolCallId, params, _onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("omp_recover cancelled");

    const mode: "report" | "repair" = params.mode ?? "report";
    const suggestions: string[] = [];

    const details: {
      expired_session_ids: string[];
      stale_lock_paths: Array<{ path: string; lock_id: string; session_id: string }>;
      pending_journal_ids: string[];
      missing_receipt_paths: string[];
      missing_diff_paths: string[];
    } = {
      expired_session_ids: [],
      stale_lock_paths: [],
      pending_journal_ids: [],
      missing_receipt_paths: [],
      missing_diff_paths: [],
    };

    let summary = {
      expired_sessions: 0,
      stale_locks: 0,
      pending_journals: 0,
      missing_receipts: 0,
      missing_diffs: 0,
      orphaned_rows: 0,
    };

    let store_available = false;

    try {
      // ── Open store ──
      const store = getPgliteStore({ repoRoot: pi.cwd });
      await store.migrate();
      store_available = true;

      // ── 1. Expired sessions (via store method — also cleans up locks/claims) ──
      const expiredReport = await store.abandonExpiredSessions();
      summary.expired_sessions = expiredReport.abandoned_count;
      details.expired_session_ids = expiredReport.abandoned_session_ids;

      // ── 3. Pending journals (via store method) ──
      const pending = await store.findPendingJournals();
      summary.pending_journals = pending.length;
      details.pending_journal_ids = pending.map((j) => j.journal_id);

      // ── Remaining checks need raw PGlite access ──
      const pglite = await openPgliteForQuery(pi.cwd);

      if (pglite.db) {
        try {
          // ── 2. Stale locks (after abandonExpiredSessions has run, report any remaining) ──
          const staleResult = await pglite.db.query<{
            lock_id: string;
            path: string;
            session_id: string;
          }>(
            `SELECT lock_id, path, session_id FROM path_locks
             WHERE status = 'active' AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          );
          summary.stale_locks = staleResult.rows.length;
          details.stale_lock_paths = staleResult.rows.map((r) => ({
            path: r.path,
            lock_id: r.lock_id,
            session_id: r.session_id,
          }));

          // ── 4. Missing receipt artifacts ──
          const receiptsResult = await pglite.db.query<{ receipt_path: string }>(
            `SELECT receipt_path FROM tool_receipts WHERE receipt_path IS NOT NULL`,
          );
          for (const row of receiptsResult.rows) {
            if (!existsSync(row.receipt_path)) {
              details.missing_receipt_paths.push(row.receipt_path);
            }
          }
          summary.missing_receipts = details.missing_receipt_paths.length;

          // ── 5. Missing diff artifacts ──
          const diffsResult = await pglite.db.query<{ diff_path: string }>(
            `SELECT diff_path FROM tool_file_effects WHERE diff_path IS NOT NULL`,
          );
          for (const row of diffsResult.rows) {
            if (!existsSync(row.diff_path)) {
              details.missing_diff_paths.push(row.diff_path);
            }
          }
          summary.missing_diffs = details.missing_diff_paths.length;

          // ── 6. Orphaned rows ──
          // Invocations without receipts
          const orphanInvResult = await pglite.db.query<{ count: number }>(
            `SELECT COUNT(*) as count FROM tool_invocations ti
             WHERE ti.receipt_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM tool_receipts tr WHERE tr.receipt_id = ti.receipt_id)`,
          );
          // Effects without invocations
          const orphanEffResult = await pglite.db.query<{ count: number }>(
            `SELECT COUNT(*) as count FROM tool_file_effects tfe
             WHERE NOT EXISTS (SELECT 1 FROM tool_invocations ti WHERE ti.invocation_id = tfe.invocation_id)`,
          );
          summary.orphaned_rows =
            Number(orphanInvResult.rows[0]?.count ?? 0) +
            Number(orphanEffResult.rows[0]?.count ?? 0);
        } finally {
          await pglite.db.close();
        }
      }

      // ── Suggestions (v1 — report only) ──
      if (mode === "repair") {
        suggestions.push("Run `omp_recover --mode=report` to inspect and auto-clean expired sessions and stale locks.");
        if (summary.pending_journals > 0) {
          suggestions.push(
            `Pending journals (${summary.pending_journals}) can be rolled back by re-running with --mode=report which triggers abandonment.`,
          );
        }
        if (summary.missing_receipts > 0) {
          suggestions.push(`Missing receipt paths (${summary.missing_receipts}) may need receipt replay.`);
        }
        if (summary.missing_diffs > 0) {
          suggestions.push(`Missing diff files (${summary.missing_diffs}) may need diff regeneration.`);
        }
        if (summary.orphaned_rows > 0) {
          suggestions.push(`Orphaned rows (${summary.orphaned_rows}) can be cleaned with a manual SQL sweep.`);
        }
        if (
          summary.expired_sessions === 0 &&
          summary.stale_locks === 0 &&
          summary.pending_journals === 0 &&
          summary.missing_receipts === 0 &&
          summary.missing_diffs === 0 &&
          summary.orphaned_rows === 0
        ) {
          suggestions.push("No recovery items found. Coordination state is clean.");
        }
      } else {
        if (summary.expired_sessions > 0) {
          suggestions.push(
            `Expired sessions (${summary.expired_sessions}) have been abandoned and their locks released.`,
          );
        }
        if (summary.stale_locks > 0) {
          suggestions.push(
            `Stale locks (${summary.stale_locks}) remain after cleanup; run repair mode for suggested actions.`,
          );
        }
        if (summary.pending_journals > 0) {
          suggestions.push(
            `Pending write journals (${summary.pending_journals}) exist. Run repair mode for rollback suggestions.`,
          );
        }
        if (summary.missing_receipts > 0) {
          suggestions.push(
            `Missing receipt files (${summary.missing_receipts}) detected. Receipt data may be unrecoverable.`,
          );
        }
        if (summary.missing_diffs > 0) {
          suggestions.push(
            `Missing diff files (${summary.missing_diffs}) detected. Diff history is incomplete.`,
          );
        }
        if (summary.orphaned_rows > 0) {
          suggestions.push(
            `Orphaned database rows (${summary.orphaned_rows}) detected. Run repair mode for cleanup suggestions.`,
          );
        }
        if (
          summary.expired_sessions === 0 &&
          summary.stale_locks === 0 &&
          summary.pending_journals === 0 &&
          summary.missing_receipts === 0 &&
          summary.missing_diffs === 0 &&
          summary.orphaned_rows === 0
        ) {
          suggestions.push("No issues found. Coordination store is clean.");
        }
      }
    } catch (err) {
      store_available = false;
      const msg = err instanceof Error ? err.message : String(err);
      suggestions.push(`Store unavailable: ${msg}. Falling back to file-system-only checks.`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              mode,
              store_available,
              summary,
              details,
              suggestions,
            },
            null,
            2,
          ),
        },
      ],
      details: {
        tool: TOOL_ID,
        version: TOOL_VERSION,
        mode,
        store_available,
        summary,
        suggestion_count: suggestions.length,
      },
    };
  },
});

export default factory;
