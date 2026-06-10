// ─── Review Export Constants ───────────────────────────────────────────────

import { spawnSync } from "node:child_process";

import type { CodeReviewExportProfile } from "./types.js";
import type { FileEntry } from "./types.js";
import { formatBytes } from "./fs-utils.js";

// ─── Constants ─────────────────────────────────────────────────────────

// Native MCP required paths — files that must exist for review export to succeed.
// Historical .omp/ paths are no longer mandatory; the exporter discovers them if present.
const REQUIRE_MISSING_FAIL = [
  "packages/tribunus-mcp/src/services/review-export/bootstrap-builder.ts",
  "packages/tribunus-mcp/src/services/review-export/source-graph.ts",
  "packages/tribunus-mcp/src/services/review-export/verify-packets.ts",
  "packages/tribunus-mcp/src/services/review-export/gemini-ir-builder.ts",
  "packages/tribunus-mcp/src/services/review-export/gemini-attachment-builder.ts",
  "packages/tribunus-mcp/src/services/review-export/progress.ts",
  "packages/tribunus-mcp/src/services/review-export/archive.ts",
  "packages/tribunus-mcp/src/services/review-export/types.ts",
  "packages/tribunus-mcp/src/services/review-export/constants.ts",
  "packages/tribunus-mcp/src/services/review-export/classification.ts",
  "packages/tribunus-mcp/src/services/review-export/policy.ts",
  "packages/tribunus-mcp/src/services/review-export/source-excerpt.ts",
  "packages/tribunus-mcp/src/services/review-export/treesitter.ts",
  "packages/tribunus-mcp/src/services/review-export/import-analysis.ts",
  "packages/tribunus-mcp/src/services/code-intelligence/indexer.ts",
  "packages/tribunus-mcp/src/services/code-intelligence/snapshot.ts",
  "packages/tribunus-mcp/src/services/code-intelligence/parsers/tree-sitter-languages.ts",
  "packages/tribunus-mcp/src/services/code-intelligence/parsers/tree-sitter.ts",
  "packages/tribunus-mcp/src/services/code-intelligence/parsers/typescript-program.ts",
  "packages/tribunus-mcp/src/services/code-intelligence/store/code-index-types.ts",
  "packages/tribunus-mcp/src/services/code-intelligence/store/code-index-store.ts",
  "packages/tribunus-mcp/src/services/code-intelligence/store/migrations/0001_code_files.sql",
  "packages/tribunus-mcp/src/services/code-intelligence/store/migrations/0002_symbols_imports_references.sql",
  "packages/tribunus-mcp/src/services/code-intelligence/store/migrations/0003_tests_findings_snapshots.sql",
  "packages/tribunus-mcp/src/services/store/pglite-types.ts",
  "packages/tribunus-mcp/src/services/store/pglite-runtime.ts",
  "packages/tribunus-mcp/src/services/store/pglite-store.ts",
  "packages/tribunus-mcp/src/services/store/pglite-migrations.ts",
  "packages/tribunus-mcp/src/services/store/migrations/0001_core.sql",
  "packages/tribunus-mcp/src/services/store/migrations/0002_indexes.sql",
  "packages/tribunus-mcp/src/services/config.ts",
  "packages/tribunus-mcp/src/server/registry.ts",
  "packages/tribunus-mcp/src/server/server.ts",
  "packages/tribunus-mcp/src/server/dispatch.ts",
  "packages/tribunus-mcp/src/governance/paths.ts",
  "packages/tribunus-mcp/src/governance/receipts.ts",
  "packages/tribunus-mcp/src/governance/capabilities.ts",
  "packages/tribunus-mcp/src/governance/store.ts",
  "packages/tribunus-mcp/src/governance/subprocess.ts",
  "packages/tribunus-mcp/src/governance/secrets.ts",
  "packages/tribunus-mcp/src/governance/sync.ts",
  "packages/tribunus-mcp/src/governance/invocation-context.ts",
  "packages/tribunus-mcp/src/governance/limits.ts",
  "packages/tribunus-mcp/src/shared/errors.ts",
  "packages/tribunus-mcp/src/shared/digests.ts",
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
