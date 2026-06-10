import { registerTool } from "../../server/registry.js"
import { join } from "node:path"
import { resolve } from "node:path"

const COMPUTE_NATIVE_DIR = process.env.TRIBUNUS_COMPUTE_DIR || resolve(process.cwd(), "packages/compute-native")
const EVIDENCE_DB = process.env.TRIBUNUS_EVIDENCE_DB || join(COMPUTE_NATIVE_DIR, "evidence.duckdb")

function ok(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] } }

export function registerEvidenceTools(): void {
  // Re-exports for duckdb tools — these are thin wrappers that the compute domain also registers
  // This module exists for future evidence-specific tooling (Parquet exports, Arrow queries, etc.)
  // For now, evidence tools are registered by registerComputeTools() above.
  // When evidence tools grow beyond DuckDB queries, add them here.
}
