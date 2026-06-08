import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import type { OmpToolContextV1, OmpActorV1 } from "./types.js"
import type { OmpRelationalStoreV1 } from "./store/pglite-types.js"

export type BuildToolContextOptions = {
  cwd: string
  repoRoot?: string
  mode?: "loose" | "governed" | "ci"
  actor?: Partial<OmpActorV1>
  sessionId?: string
  store?: OmpRelationalStoreV1
}

export function buildToolContext(opts: BuildToolContextOptions): OmpToolContextV1 {
  const repoRoot = opts.repoRoot ?? opts.cwd
  const mode = opts.mode ?? "loose"
  const actor: OmpActorV1 = { kind: "unknown", ...opts.actor }
  const session_id = opts.sessionId ?? `omp_ses_${Date.now()}_${randomBytes(4).toString("hex")}`

  return {
    cwd: opts.cwd,
    repo_root: repoRoot,
    mode,
    actor,
    session_id,
    limits: {
      max_file_bytes: 1_000_000,
      max_output_bytes: 100_000,
      max_files_touched: 20,
      path_lock_ttl_ms: 5 * 60 * 1000,
    },
    paths: {
      receipts_dir: resolve(repoRoot, ".omp/evidence/receipts"),
      diffs_dir: resolve(repoRoot, ".omp/evidence/diffs"),
      events_path: resolve(repoRoot, ".omp/evidence/events/tool-events.jsonl"),
      journals_dir: resolve(repoRoot, ".omp/evidence/journals"),
      evidence_root: resolve(repoRoot, ".omp/evidence"),
      pglite_dir: resolve(repoRoot, ".omp/state/pglite"),
      duckdb_path: resolve(repoRoot, ".omp/state/analytics.duckdb"),
    },
    store: opts.store,
  }
}
