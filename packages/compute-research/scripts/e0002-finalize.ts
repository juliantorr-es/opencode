// E0002 finalize → normalize → DuckDB pipeline
import { join } from "path";
import { RunDirectory } from "../src/recorder/run-dir.js";
import { finalizeRun } from "../src/recorder/finalize.js";
import { normalizeRun } from "../src/normalize/normalize.js";
import { buildDuckDb } from "../src/normalize/duckdb.js";
import type { DuckDbResult } from "../src/normalize/duckdb.js";
import { createHash } from "crypto";
import { readdirSync, existsSync } from "fs";

const RESEARCH_DATA = join(import.meta.dir, "..", "..", "compute-native", "research-data");
const RUN_ID = "E0002-R1-20260609";
const runDir = new RunDirectory(RUN_ID, RESEARCH_DATA);
const finalDir = join(RESEARCH_DATA, `${RUN_ID}-final`);
const normDir = join(RESEARCH_DATA, `${RUN_ID}-norm`);
const dbPath = join(RESEARCH_DATA, `${RUN_ID}.duckdb`);

console.log("=== Finalize ===");
const result = finalizeRun(runDir);
if (result.error) {
  console.error("Finalization failed:", result.error);
  process.exit(1);
}
console.log("  final_digest:", result.final_digest.slice(0, 32) + "...");
console.log("  file_count:", result.file_count);
console.log("  byte_count:", result.byte_count);

console.log("\n=== Normalize ===");
const normResult = normalizeRun(finalDir, normDir);
if (normResult.error) {
  console.error("Normalization failed:", normResult.error);
  process.exit(1);
}
console.log("  files:", normResult.files.length);
console.log("  referential_integrity:", JSON.stringify(normResult.referential_integrity));

// Compute normalized dataset digest from sorted file hashes
const h = createHash("sha256");
for (const f of normResult.files.sort((a, b) => a.name.localeCompare(b.name))) {
  if (f.sha256) h.update(f.sha256);
}
const normDigest = h.digest("hex");
console.log("  normalized_dataset_digest:", normDigest);

console.log("\n=== DuckDB ===");
let dbResult: DuckDbResult = { db_path: dbPath, executed: false, error: "DuckDB CLI not available" };
try {
  dbResult = buildDuckDb(normDir, dbPath);
} catch (e: unknown) {
  dbResult = { db_path: dbPath, executed: false, error: e instanceof Error ? e.message : String(e) };
}
console.log("  executed:", dbResult.executed);
if (dbResult.error) console.log("  error:", dbResult.error);
if (dbResult.smoke_query_result) console.log("  smoke:", JSON.stringify(dbResult.smoke_query_result));

// Output final digests for evidence record
console.log("\n=== Final Digests ===");
console.log(JSON.stringify({
  finalization_digest: result.final_digest,
  normalized_dataset_digest: normDigest,
  duckdb_executed: dbResult.executed,
}, null, 2));
