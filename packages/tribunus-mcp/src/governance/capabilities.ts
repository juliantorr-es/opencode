export type Capability =
  | "github:read"
  | "github:write"
  | "compute:build"
  | "compute:bench"
  | "compute:profile"
  | "compute:inference"
  | "evidence:read"
  | "evidence:admin"
  | "model:acquire"
  | "hardware:monitor"
  | "repository:read"
  | "repository:index"
  | "artifact:write"
  | "artifact:verify"
  | "control-plane:read"
  | "control-plane:write"
  | "artifact:read"
  | "artifact:verify"
  | "artifact:admin"
  | "artifact:write"

export const TOOL_CAPABILITIES: Record<string, Capability[]> = {
  // GitHub
  github_api: ["github:read", "github:write"],
  create_or_update_file: ["github:write"],
  get_file_contents: ["github:read"],
  create_pull_request: ["github:write"],
  merge_pull_request: ["github:write"],
  create_issue: ["github:write"],
  list_issues: ["github:read"],
  list_workflow_runs: ["github:read"],
  trigger_workflow: ["github:write"],
  create_release: ["github:write"],
  get_pages_config: ["github:read"],
  create_pages_site: ["github:write"],
  update_pages_config: ["github:write"],
  delete_pages_site: ["github:write"],
  list_deployments: ["github:read"],
  get_deployment_status: ["github:read"],
  cancel_deployment: ["github:write"],
  get_latest_build: ["github:read"],
  list_builds: ["github:read"],
  request_build: ["github:write"],
  list_repositories: ["github:read"],
  get_repository: ["github:read"],
  compare_commits: ["github:read"],
  create_branch: ["github:write"],
  get_commit: ["github:read"],
  list_workflow_jobs: ["github:read"],
  // Compute Kernel
  hf_search_models: ["model:acquire"],
  hf_get_model_info: ["model:acquire"],
  hf_download_model: ["model:acquire"],
  macmon_metrics: ["hardware:monitor"],
  macmon_session: ["hardware:monitor"],
  cargo_build: ["compute:build"],
  cargo_bench: ["compute:bench"],
  cargo_check: ["compute:build"],
  metal_compile: ["compute:build"],
  xctrace_record: ["compute:profile"],
  duckdb_query: ["evidence:read"],
  duckdb_list_tables: ["evidence:read"],
  duckdb_admin_execute: ["evidence:admin"],
  mlx_inference: ["compute:inference"],
  mlx_benchmark: ["compute:bench", "compute:inference"],
  // OMP Harness (to be migrated to native)
  omp_task_board: ["github:read"],
  omp_recover: ["github:read"],
  omp_history: ["github:read"],
  omp_smart_git: ["github:read", "github:write"],
  omp_smart_grep: ["github:read"],
  omp_smart_find: ["github:read"],
  omp_read_source: ["github:read"],
  omp_semantic_repo_map: ["github:read"],
  omp_smart_bun: ["compute:build"],
  // Tribunus-branded tools
  tribunus_search: ["repository:read"],
  tribunus_find: ["repository:read"],
  tribunus_source_read: ["repository:read"],
  tribunus_repository_map: ["repository:index"],
  tribunus_code_review_export: ["artifact:write"],
  tribunus_review_packet_export: ["artifact:write"],
  tribunus_semantic_review_export: ["artifact:write"],
  tribunus_review_verify: ["artifact:verify"],
  tribunus_symbol_lookup: ["repository:index"],
  tribunus_impact_analysis: ["repository:index"],
  tribunus_authority_audit: ["repository:index"],
  tribunus_test_gap_report: ["repository:index"],
  tribunus_board: ["control-plane:read"],
  tribunus_recover: ["control-plane:read"],
  tribunus_history: ["control-plane:read"],
  tribunus_memory_sync: ["control-plane:read"],
  tribunus_memory_recall: ["control-plane:read"],
}

export function checkCapability(tool: string): { allowed: boolean; missing: Capability[] } {
  const required = TOOL_CAPABILITIES[tool]
  if (!required) return { allowed: true, missing: [] }
  const enabled = (process.env.TRIBUNUS_CAPABILITIES || "").split(",").map(s => s.trim()).filter(Boolean)
  if (enabled.length === 0) return { allowed: true, missing: [] }
  const missing = required.filter(c => !enabled.includes(c))
  return { allowed: missing.length === 0, missing }
}
