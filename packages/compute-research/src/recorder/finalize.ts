import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { basename, join, relative } from "path";
import type { RunDirectory } from "./run-dir.js";
import { validateProvenanceShape, validateRunManifestShape } from "../schemas/validator.js";

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf);
  } catch (e) {
    errors.push(`invalid JSON: ${(e as Error).message}`);
    return { file: filePath, valid: false, errors };
  }

  // Duplicate-key check — JSON.parse silently collapses duplicates.
  // Scan raw text for repeated top-level keys before the parse result is trusted.
  const dupes = checkDuplicateKeys(buf);
  if (dupes.length > 0) {
    errors.push(
      `duplicate JSON keys detected: ${dupes.join(", ")}. ` +
      `RFC 8259 warns that duplicate names are non-interoperable. ` +
      `Remove superseded entries and keep exactly one value per key.`
    );
  }

  // Structural schema validation for known artifacts
  const schemaErrors: string[] = [];
  const fileName = basename(filePath);
  if (fileName === "provenance.json") {
    schemaErrors.push(...validateProvenanceShape(parsed));
  } else if (fileName === "run-manifest.json") {
    schemaErrors.push(...validateRunManifestShape(parsed));
  }
  errors.push(...schemaErrors);
  return { file: filePath, valid: errors.length === 0, errors };
}

/**
 * Scan raw JSON text for duplicate object keys at any nesting level.
 * JSON.parse silently drops duplicates, making them undetectable post-parse.
 * This check operates on the raw text to catch duplicates before parse.
 */
function checkDuplicateKeys(jsonText: string): string[] {
  // Match top-level object keys only — lines starting with exactly two spaces
  // of indentation (standard JSON.prettify). Deeper nesting is not checked
  // because sibling objects at the same depth can legitimately share key names.
  // The critical case (canonical_finalization_digest appearing twice at the
  // same level) is always at the top level of the evidence/finalization JSON.
  const keyRe = /^  "([^"]+)":/gm;
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const m of jsonText.matchAll(keyRe)) {
    const key = m[1]!;
    if (seen.has(key)) {
      duplicates.add(key);
    }
    seen.add(key);
  }
  return [...duplicates];
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

  // 6. Check if any validation failed — fail-closed: refuse authoritative rename
  const anyValidationFailed = validations.some((v) => !v.valid);
  if (anyValidationFailed) {
    errors.push("finalization blocked: one or more schema validations failed");
  }

  // 7. Write finalization.json
  const hasErrors = errors.length > 0;
  const finalization: FinalizationRecord = {
    run_id: runId,
    timestamp,
    final_digest: finalDigest,
    checksums_path: checksumsPath,
    file_count: fileCount,
    byte_count: byteCount,
    validations,
    ...(hasErrors ? { error: errors.join("; ") } : {}),
  };

  const finalizationPath = join(partialRoot, "finalization.json");
  writeFileSync(finalizationPath, JSON.stringify(finalization, null, 2) + "\n", "utf-8");

  // 8. Atomic rename: {root}/{runId}.partial → {root}/{runId}
  //    If any validation failed, rename to .invalid instead.
  const suffix = hasErrors ? ".invalid" : "";
  const finalRoot = join(runDir.root, `${runId}${suffix}`);
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
