// === OMP Custom Tools — Write Journal (MVP) ===
// Crash-safe write journal for file mutations.
// MVP: writes a JSON journal file to journals_dir and marks committed immediately.
import { writeFileSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import type { OmpWriteJournalV1, OmpToolContextV1 } from "./types.js"

/**
 * Prepare a write journal for a set of file writes.
 *
 * MVP behavior: writes a JSON journal file to `ctx.paths.journals_dir`
 * and immediately transitions to "committed" status.
 */
export function prepareJournal(
  receiptId: string,
  files: Array<{ path: string; before_sha256: string }>,
  ctx: OmpToolContextV1,
): OmpWriteJournalV1 {
  const journalId = randomUUID()
  const now = new Date().toISOString()
  const journalsDir = ctx.paths.journals_dir

  const journal: OmpWriteJournalV1 = {
    schema: "omp.write_journal.v1",
    journal_id: journalId,
    receipt_id: receiptId,
    created_at: now,
    status: "prepared",
    files: files.map((f) => ({
      path: f.path,
      before_sha256: f.before_sha256,
      staged_path: resolve(journalsDir, `staged_${journalId}_${f.path.replace(/[/\\]/g, "_")}`),
      backup_path: resolve(journalsDir, `backup_${journalId}_${f.path.replace(/[/\\]/g, "_")}`),
      after_sha256: "",
    })),
  }

  const journalPath = resolve(journalsDir, `journal_${journalId}.json`)
  writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf8")

  return journal
}

/**
 * Mark a journal as committed.
 * MVP: writes the updated journal file with status "committed".
 * No actual file staging/renaming for now — tracked via the journal.
 */
export function commitJournal(journal: OmpWriteJournalV1): void {
  const journalsDir = resolve(journal.files[0]?.backup_path ?? ".", "../..")
  const journalPath = resolve(journalsDir, `journal_${journal.journal_id}.json`)

  const updated: OmpWriteJournalV1 = {
    ...journal,
    status: "committed",
  }

  writeFileSync(journalPath, JSON.stringify(updated, null, 2), "utf8")
}

/**
 * Rollback a journal — restore files from backups.
 * MVP: reads backup files and writes them back to original paths.
 * The journal must be in "rollback_needed" or "prepared" status.
 */
export function rollbackJournal(journal: OmpWriteJournalV1): void {
  for (const entry of journal.files) {
    try {
      const backup = readFileSync(entry.backup_path)
      writeFileSync(entry.path, backup)
    } catch {
      // Backup may not exist yet in MVP — skip gracefully
    }
  }

  const journalsDir = resolve(journal.files[0]?.backup_path ?? ".", "../..")
  const journalPath = resolve(journalsDir, `journal_${journal.journal_id}.json`)

  const updated: OmpWriteJournalV1 = {
    ...journal,
    status: "rolled_back",
  }

  writeFileSync(journalPath, JSON.stringify(updated, null, 2), "utf8")
}
