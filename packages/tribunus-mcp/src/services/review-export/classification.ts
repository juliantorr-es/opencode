// classification.ts — file category, importance, embedding mode classification

import { sourceLikeExtensions } from "./fs-utils.js";


function classifyFileCategory(path: string): string {
  if (path.startsWith(".omp/tools/_lib/store/")) return "pglite_store";
  if (path.startsWith(".omp/tools/_lib/analytics/")) return "duckdb_projection";
  if (path.startsWith(".omp/tools/_lib/adapters/")) return "package_source";
  if (path.startsWith(".omp/tools/manifests/")) return "omp_manifest";
  if (path.startsWith(".omp/tools/tests/")) return "omp_test";
  if (path.startsWith(".omp/tools/")) return "omp_tool";
  if (path === ".omp/mcp.json" || path === ".omp/mcp-manifest.v1.json") return "mcp_config";
  if (path.startsWith("packages/")) {
    if (path.includes("/tests/") || path.includes("/test/")) return "package_test";
    return "package_source";
  }
  if (path.startsWith("schemas/")) return "schema";
  if (path.startsWith("docs/adr/") || path.startsWith("docs/json/adrs/")) return "adr";
  if (path.startsWith("docs/json/omp/")) return "board_artifact";
  if (path.startsWith(".github/workflows/")) return "workflow";
  if (path.startsWith("scripts/") || path.startsWith("script/")) return "script";
  if (path === "package.json" || path.startsWith("tsconfig") || path.endsWith(".config.ts") || path.endsWith(".config.js")) return "config";
  if (path.endsWith(".md")) return "doc";
  if (path.endsWith(".sql")) return "schema";
  if (path.endsWith(".json") || path.endsWith(".jsonc")) return "config";
  return "asset";
}

function importanceForFile(path: string): "authority_critical" | "review_context" | "background" | "low_signal" {
  if (
    path.startsWith(".omp/tools/") ||
    path === ".omp/mcp.json" ||
    path === ".omp/mcp-manifest.v1.json" ||
    path.startsWith(".omp/tools/manifests/") ||
    path.startsWith(".omp/tools/tests/") ||
    path.startsWith(".omp/tools/_lib/store/") ||
    path.startsWith(".omp/tools/_lib/analytics/")
  ) {
    return "authority_critical";
  }
  if (path.startsWith("packages/opencode/src/coordination/") || path.startsWith("packages/opencode/src/storage/") || path.startsWith("packages/opencode/src/tool/")) {
    return "review_context";
  }
  if (path.startsWith("docs/") || path.startsWith("packages/") || path.startsWith("schemas/")) {
    return "background";
  }
  return "low_signal";
}

function shouldEmbedFullSource(path: string): boolean {
  return (
    path.startsWith(".omp/tools/") ||
    path.startsWith(".omp/tools/_lib/adapters/") ||
    path.startsWith(".omp/tools/manifests/") ||
    path.startsWith(".omp/tools/tests/") ||
    path.startsWith(".omp/tools/_lib/store/") ||
    path.startsWith(".omp/tools/_lib/analytics/") ||
    path === ".omp/mcp.json" ||
    path === ".omp/mcp-manifest.v1.json" ||
    path === ".omp/tools/code_review_export.ts"
  );
}

function classifyV1FileCategory(path: string): string {
  if (path.startsWith(".omp/tools/_lib/store/migrations/") || path.endsWith(".sql")) return "schema";
  if (path.startsWith(".omp/tools/_lib/store/")) return "pglite_store";
  if (path.startsWith(".omp/tools/_lib/analytics/views/")) return "schema";
  if (path.startsWith(".omp/tools/_lib/analytics/")) return "duckdb_projection";
  if (path.startsWith(".omp/tools/_lib/adapters/")) return "omp_kernel";
  if (path.startsWith(".omp/tools/_lib/")) return "omp_kernel";
  if (path.startsWith(".omp/tools/manifests/")) return "omp_manifest";
  if (path.startsWith(".omp/tools/tests/")) return "omp_test";
  if (path.startsWith(".omp/tools/")) return "omp_tool";
  if (path === ".omp/mcp.json" || path === ".omp/mcp-manifest.v1.json") return "mcp_config";
  if (path.startsWith("packages/")) {
    if (path.includes("/tests/") || path.includes("/test/")) return "package_test";
    return "package_source";
  }
  if (path.startsWith("docs/adr/") || path.startsWith("docs/json/adrs/") || path.startsWith("adr/") || path.startsWith("adrs/")) return "adr";
  if (path.startsWith("docs/json/omp/") || path.startsWith("docs/json/current/")) return "board_artifact";
  if (path.startsWith(".github/workflows/")) return "workflow";
  if (path.startsWith("scripts/") || path.startsWith("script/")) return "script";
  if (path === "package.json" || path.startsWith("tsconfig") || path.endsWith(".config.ts") || path.endsWith(".config.js") || path.endsWith(".config.mts") || path.endsWith(".config.mjs")) return "config";
  if (path.endsWith(".md")) return "doc";
  if (path.endsWith(".json") || path.endsWith(".jsonc")) return "config";
  if (path.endsWith(".sql")) return "schema";
  return "asset";
}

function importanceForV1File(path: string): "authority_critical" | "review_context" | "background" | "low_signal" {
  if (
    path.startsWith(".omp/tools/") ||
    path === ".omp/mcp.json" ||
    path === ".omp/mcp-manifest.v1.json" ||
    path.startsWith(".omp/tools/manifests/") ||
    path.startsWith(".omp/tools/tests/") ||
    path.startsWith(".omp/tools/_lib/store/") ||
    path.startsWith(".omp/tools/_lib/analytics/") ||
    path.startsWith(".omp/tools/_lib/adapters/")
  ) {
    return "authority_critical";
  }
  if (
    path.startsWith("packages/opencode/src/coordination/") ||
    path.startsWith("packages/opencode/src/storage/") ||
    path.startsWith("packages/opencode/src/tool/") ||
    path.startsWith("packages/opencode/src/session/") ||
    path.startsWith("packages/core/src/") ||
    path.startsWith("packages/llm/src/")
  ) {
    return "review_context";
  }
  if (path.startsWith("docs/") || path.startsWith("schemas/") || path.startsWith("packages/")) {
    return "background";
  }
  return "low_signal";
}

function sourceEmbeddingMode(path: string): "full" | "excerpt" | "signature_only" | "summary_only" {
  if (shouldEmbedFullSource(path)) return "full";
  if (path.startsWith("packages/") && (sourceLikeExtensions(path) || path.endsWith(".mts") || path.endsWith(".cts"))) return "excerpt";
  if (path.endsWith(".sql") || path.endsWith(".json")) return "excerpt";
  if (path.endsWith(".md")) return "summary_only";
  return "summary_only";
}

export {
  classifyFileCategory,
  importanceForFile,
  shouldEmbedFullSource,
  classifyV1FileCategory,
  importanceForV1File,
  sourceEmbeddingMode,
};
