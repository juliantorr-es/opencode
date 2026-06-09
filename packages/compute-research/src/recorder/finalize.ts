import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, relative } from "path";
import type { RunDirectory } from "./run-dir.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SchemaValidationEntry {
  file: string;
  valid: boolean;
  errors: string[];
}

export interface FinalizationRecord {
  run_id: string;
  timestamp: string;
  final_digest: string;
  checksums_path: string;
  file_count: number;
  byte_count: number;
  validations: SchemaValidationEntry[];
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256File(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function validateJsonFile(filePath: string): SchemaValidationEntry {
  const errors: string[] = [];
  const buf = readFileSync(filePath, "utf-8");
  try {
    JSON.parse(buf);
  } catch (e) {
    errors.push(`invalid JSON: ${(e as Error).message}`);
  }
  return { file: filePath, valid: errors.length === 0, errors };
}

function isJsonFile(name: string): boolean {
  return name.endsWith(".json");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Finalize a run directory.
 *
 * 1. Flushes all write streams.
 * 2. Closes all file handles.
 * 3. Computes SHA-256 for every file in `.partial`.
 * 4. Writes `checksums.sha256`.
 * 5. Validates JSON files via parse check.
 * 6. Writes `finalization.json`.
 * 7. Atomically renames `.partial` → final name.
 */
export function finalizeRun(runDir: RunDirectory): FinalizationRecord {
  const errors: string[] = [];
  const partialRoot = runDir.partialRoot;
  const runId = runDir.runId;
  const timestamp = new Date().toISOString();

  // 1. Flush
  try {
    runDir.flush();
  } catch (e) {
    errors.push(`flush failed: ${(e as Error).message}`);
  }

  // 2. Close all file handles
  try {
    runDir.close();
  } catch (e) {
    errors.push(`close failed: ${(e as Error).message}`);
  }

  // 3. Walk .partial and checksum everything
  const checksumLines: string[] = [];
  const validations: SchemaValidationEntry[] = [];
  let fileCount = 0;
  let byteCount = 0;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const hash = sha256File(full);
        const rel = relative(partialRoot, full);
        checksumLines.push(`${hash}  ${rel}`);
        fileCount++;
        byteCount += st.size;

        // Validate JSON files (skip the checksum/finalization files we're about to write)
        if (isJsonFile(entry) && rel !== "checksums.sha256") {
          validations.push(validateJsonFile(full));
        }
      }
    }
  }
  walk(partialRoot);

  // 4. Write checksums.sha256
  checksumLines.sort();
  const checksumContent = checksumLines.join("\n") + "\n";
  const checksumsPath = join(partialRoot, "checksums.sha256");
  writeFileSync(checksumsPath, checksumContent, "utf-8");

  // 5. Compute final digest (SHA-256 of the sorted, canonical checksum listing)
  const finalDigest = createHash("sha256").update(checksumContent).digest("hex");

  // 6. Write finalization.json
  const finalization: FinalizationRecord = {
    run_id: runId,
    timestamp,
    final_digest: finalDigest,
    checksums_path: checksumsPath,
    file_count: fileCount,
    byte_count: byteCount,
    validations,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };

  const finalizationPath = join(partialRoot, "finalization.json");
  writeFileSync(finalizationPath, JSON.stringify(finalization, null, 2) + "\n", "utf-8");

  // 7. Atomic rename: {root}/{runId}.partial → {root}/{runId}
  const finalRoot = join(runDir.root, runId);
  try {
    renameSync(partialRoot, finalRoot);
    finalization.checksums_path = join(finalRoot, "checksums.sha256");
  } catch (e) {
    errors.push(`atomic rename failed: ${(e as Error).message}`);
    if (!finalization.error) {
      finalization.error = errors.join("; ");
    }
  }

  return finalization;
}
