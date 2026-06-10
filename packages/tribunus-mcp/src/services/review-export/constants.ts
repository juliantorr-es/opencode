// ─── Review Export Constants ───────────────────────────────────────────────

import { spawnSync } from "node:child_process";

import type { CodeReviewExportProfile } from "./types.js";
import type { FileEntry } from "./types.js";
import { formatBytes } from "./fs-utils.js";

// ─── Constants ─────────────────────────────────────────────────────────

const REQUIRE_MISSING_FAIL = [
  ".omp/tools/struct_read.ts",
  ".omp/tools/text_replace.ts",
  ".omp/tools/batch_edit.ts",
  ".omp/tools/code_review_export.ts",
  ".omp/tools/review_packet_export.ts",
  ".omp/tools/semantic_review_packet_export.ts",
  ".omp/tools/verify_review_packets.ts",
  ".omp/tools/_lib/types.ts",
  ".omp/tools/_lib/envelope.ts",
  ".omp/tools/_lib/path-policy.ts",
  ".omp/tools/_lib/hashing.ts",
  ".omp/tools/_lib/receipts.ts",
  ".omp/tools/_lib/diff.ts",
  ".omp/tools/_lib/manifest.ts",
  ".omp/tools/_lib/schemas.ts",
  ".omp/tools/_lib/errors.ts",
  ".omp/tools/_lib/ids.ts",
  ".omp/tools/_lib/json.ts",
  ".omp/tools/_lib/audit.ts",
  ".omp/tools/_lib/tool-context.ts",
  ".omp/tools/_lib/write-journal.ts",
  ".omp/tools/_lib/text-file.ts",
  ".omp/tools/_lib/redaction.ts",
  ".omp/tools/_lib/review-export/source-graph.ts",
  ".omp/tools/_lib/review-export/verify-packets.ts",
  ".omp/tools/manifests/struct_read.v1.json",
  ".omp/tools/manifests/text_replace.v1.json",
  ".omp/tools/manifests/batch_edit.v1.json",
  ".omp/tools/manifests/code_review_export.v1.json",
  ".omp/tools/manifests/review_packet_export.v1.json",
  ".omp/tools/manifests/semantic_review_packet_export.v1.json",
  ".omp/tools/manifests/verify_review_packets.v1.json",
  ".omp/agents/exporter.md",
  ".omp/tools/tests/path-policy.test.ts",
  ".omp/tools/tests/receipts.test.ts",
  ".omp/tools/tests/text_replace.test.ts",
  ".omp/tools/tests/batch_edit.test.ts",
  ".omp/tools/tests/struct_read.test.ts",
  ".omp/tools/tests/manifest.test.ts",
  ".omp/tools/tests/export-completeness.test.ts",
  ".omp/tools/tests/pglite-store.test.ts",
  ".omp/tools/omp_history.ts",
  ".omp/tools/omp_recover.ts",
  ".omp/tools/_lib/store/index.ts",
  ".omp/tools/_lib/store/pglite-store.ts",
  ".omp/tools/_lib/store/pglite-types.ts",
  ".omp/tools/_lib/store/pglite-migrations.ts",
  ".omp/tools/_lib/store/migrations/0001_core.sql",
  ".omp/tools/_lib/store/migrations/0002_indexes.sql",
  ".omp/tools/_lib/analytics/index.ts",
  ".omp/tools/_lib/analytics/duckdb-projector.ts",
  ".omp/tools/_lib/analytics/duckdb-types.ts",
  ".omp/tools/_lib/analytics/views/session_summary.sql",
  ".omp/tools/_lib/analytics/views/tool_quality.sql",
  ".omp/tools/_lib/analytics/views/file_churn.sql",
  ".omp/tools/_lib/analytics/views/stale_write_refusals.sql",
  ".omp/tools/_lib/analytics/views/path_lock_conflicts.sql",
  ".omp/tools/_lib/analytics/views/recovery_items.sql",
  ".omp/tools/_lib/adapters/index.ts",
  ".omp/tools/_lib/adapters/mistral.ts",
  ".omp/tools/_lib/adapters/openai.ts",
  ".omp/tools/_lib/adapters/anthropic.ts",
  ".omp/tools/_lib/adapters/mcp.ts",
  ".omp/mcp.json",
  ".omp/mcp-manifest.v1.json",
  "package.json",
  "AGENTS.md",
];

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
const GEMINI_MAX_FILE_COUNT = 5000;
const GEMINI_MAX_ZIP_BYTES = 100 * 1024 * 1024;

const V1_PACKET_ID = "tribunus-gemini-ir";
const V1_GENERATOR_VERSION = "code_review_export@gemini_structured_ir_v1";

// ─── Helpers ───────────────────────────────────────────────────────────

function getPacketRoot(profile: CodeReviewExportProfile): string {
  if (profile === "gemini_code_review") return "tribunus-gemini-code-review";
  if (profile === "gemini_ir" || profile === "gemini_structured_ir_v1") return "tribunus-gemini-ir";
  return "tribunus-source-review";
}

function getZipName(profile: CodeReviewExportProfile): string {
  if (profile === "gemini_code_review") return "tribunus-gemini-code-review.zip";
  if (profile === "gemini_ir" || profile === "gemini_structured_ir_v1") return "tribunus-gemini-ir.zip";
  return "tribunus-source-review.zip";
}

function validateGeminiBundle(args: {
  zipPath: string;
  zipSize: number;
  includedFiles: FileEntry[];
}): string[] {
  const warnings: string[] = [];
  if (args.includedFiles.length > GEMINI_MAX_FILE_COUNT) {
    warnings.push(
      `Gemini profile exceeds file-count guidance: ${args.includedFiles.length} files > ${GEMINI_MAX_FILE_COUNT}`,
    );
  }
  if (args.zipSize > GEMINI_MAX_ZIP_BYTES) {
    warnings.push(
      `Gemini profile exceeds upload guidance: ${formatBytes(args.zipSize)} > ${formatBytes(GEMINI_MAX_ZIP_BYTES)}`,
    );
  }

  const zipListing = spawnSync("unzip", ["-Z1", args.zipPath], { encoding: "utf8", timeout: 30000 });
  if (zipListing.status === 0) {
    const entries = zipListing.stdout.trim().split("\n").filter(Boolean);
    const topLevel = new Set(entries.map((entry) => entry.split("/")[0]).filter(Boolean));
    if (topLevel.size !== 1) {
      warnings.push(`Gemini profile should have exactly one top-level folder; found ${topLevel.size}`);
    }
  } else {
    warnings.push("Gemini profile validation could not inspect zip contents");
  }

  return warnings;
}

export {
  REQUIRE_MISSING_FAIL,
  MAX_FILE_BYTES,
  GEMINI_MAX_FILE_COUNT,
  GEMINI_MAX_ZIP_BYTES,
  V1_PACKET_ID,
  V1_GENERATOR_VERSION,
  getPacketRoot,
  getZipName,
  validateGeminiBundle,
};
