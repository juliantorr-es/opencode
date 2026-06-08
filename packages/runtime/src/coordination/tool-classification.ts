import type { ResourceClass } from "./tool-scheduler"

/** Classification of known tools by resource class. */
export const TOOL_CLASSIFICATION: Record<string, ResourceClass> = {
  // ── read_light ──────────────────────────────────────────
  read: "read_light",
  read_file: "read_light",
  search: "read_light",
  find: "read_light",
  lsp: "read_light",

  // ── search_medium ───────────────────────────────────────
  grep: "search_medium",
  ripgrep: "search_medium",
  ast_grep: "search_medium",
  ast_edit: "search_medium",
  semantic_search: "search_medium",

  // ── cpu_heavy ───────────────────────────────────────────
  typecheck: "cpu_heavy",
  test: "cpu_heavy",
  build: "cpu_heavy",
  lint: "cpu_heavy",
  format: "cpu_heavy",
  check: "cpu_heavy",

  // ── io_heavy ────────────────────────────────────────────
  projection_rebuild: "io_heavy",
  code_index_build: "io_heavy",
  artifact_ingest: "io_heavy",
  debug_export: "io_heavy",

  // ── exclusive_repo ──────────────────────────────────────
  git_checkpoint: "exclusive_repo",
  migration_execute: "exclusive_repo",
  npm_install: "exclusive_repo",
  package_install: "exclusive_repo",
  generated_rewrite: "exclusive_repo",

  // ── network ─────────────────────────────────────────────
  provider_call: "network",
  github_api: "network",
  web_fetch: "network",
  web_search: "network",
}

/** Default resource class for unclassified tools. */
export const DEFAULT_RESOURCE_CLASS: ResourceClass = "search_medium"

/** Returns the resource class for a tool, or the default if unclassified. */
export function classifyTool(toolName: string): ResourceClass {
  return TOOL_CLASSIFICATION[toolName] ?? DEFAULT_RESOURCE_CLASS
}

/** Returns true if this tool is a mutator (write/edit/delete). */
export function isMutator(toolName: string): boolean {
  return ["write", "edit", "bash", "git_checkpoint", "npm_install", "migration_execute", "generated_rewrite", "package_install"].includes(toolName)
}
