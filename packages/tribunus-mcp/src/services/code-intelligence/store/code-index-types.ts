import type { OmpRelationalStoreV1 } from "../../store/pglite-types.js"
import type {
  ReviewExportProgressSinkV1,
  ReviewExportTimingsV1,
} from "../../review-export/progress.js"

export type SourceAnchorV1 = {
  path: string
  sha256: string
  start_line?: number
  end_line?: number
  start_byte?: number
  end_byte?: number
  language?: string
  symbol_id?: string
}

export type SourceExcerptV1 = {
  anchor: SourceAnchorV1
  inclusion: "full" | "excerpt" | "signature_only" | "summary_only"
  reason: string
  content?: string
  omitted_bytes?: number
  omitted_reason?: string
  line_count?: number
  byte_count?: number
}

export type CodeFileRecordV1 = {
  file_id: string
  path: string
  language?: string
  category: string
  sha256: string
  size_bytes: number
  line_count?: number
  importance: "authority_critical" | "review_context" | "background" | "low_signal"
  inclusion_status: "included" | "indexed_only" | "excluded"
  parse_status: "pending" | "parsed" | "parse_error" | "unsupported_language" | "not_source"
  parse_error?: string
  indexed_at: string
  last_seen_at: string
}

export type CodeSymbolRecordV1 = {
  symbol_id: string
  file_id: string
  name: string
  kind:
    | "function"
    | "class"
    | "interface"
    | "type_alias"
    | "enum"
    | "const"
    | "variable"
    | "method"
    | "schema"
    | "tool_handler"
    | "test_case"
    | "sql_table"
    | "sql_index"
    | "migration"
    | "manifest"
    | "route"
    | "component"
    | "unknown"
  exported: boolean
  start_line?: number
  end_line?: number
  start_byte?: number
  end_byte?: number
  signature?: string
  doc_summary?: string
  authority_role?:
    | "path_policy"
    | "hash_precondition"
    | "path_lock"
    | "receipt_writer"
    | "diff_writer"
    | "audit_writer"
    | "journal_writer"
    | "store_transaction"
    | "recovery"
    | "redaction"
    | "manifest_generator"
    | "provider_adapter"
    | "semantic_indexer"
    | "review_exporter"
  symbol_hash?: string
  created_at: string
}

export type CodeImportRecordV1 = {
  import_id: string
  from_file_id: string
  specifier: string
  import_kind: "value" | "type_only" | "side_effect" | "dynamic" | "require" | "unknown"
  resolution_status:
    | "resolved_in_packet"
    | "resolved_not_embedded"
    | "resolved"
    | "resolved_not_included"
    | "external_package"
    | "builtin"
    | "ts_js_extension_remap"
    | "missing_source"
    | "missing_asset"
    | "missing_generated"
    | "missing_prompt_template"
    | "missing_route_target"
    | "unresolved"
  resolved_file_id?: string
  resolved_path?: string
  reason?: string
  start_line?: number
  end_line?: number
}

export type CodeReferenceRecordV1 = {
  reference_id: string
  from_file_id: string
  from_symbol_id?: string
  to_symbol_id?: string
  reference_kind: "definition" | "reference" | "call" | "type_reference" | "export" | "import" | "unknown"
  start_line?: number
  end_line?: number
  confidence: "semantic" | "syntactic" | "heuristic"
}

export type CodeTestRecordV1 = {
  test_id: string
  file_id: string
  suite_name?: string
  test_name: string
  framework: string
  target_file_id?: string
  target_symbol_id?: string
  assertion_kind?:
    | "path_denied"
    | "hash_required"
    | "hash_mismatch"
    | "lock_conflict"
    | "lock_release"
    | "receipt_written"
    | "diff_written"
    | "audit_event_written"
    | "pglite_row_written"
    | "journal_written"
    | "manifest_valid"
    | "export_completeness"
    | "unresolved_import_classified"
    | "other"
  start_line?: number
  end_line?: number
  confidence: "semantic" | "syntactic" | "heuristic"
}

export type CodeAuthorityFlowRecordV1 = {
  flow_id: string
  tool_id: string
  file_id: string
  flow_step:
    | "validate_input"
    | "resolve_path"
    | "acquire_path_lock"
    | "read_file"
    | "verify_hash"
    | "apply_in_memory_edit"
    | "write_journal"
    | "write_file"
    | "compute_after_hash"
    | "write_diff"
    | "write_receipt"
    | "record_store_mutation"
    | "append_audit_event"
    | "release_path_lock"
    | "return_envelope"
  detected: boolean
  symbol_id?: string
  start_line?: number
  end_line?: number
  confidence: "semantic" | "syntactic" | "heuristic" | "missing"
  notes?: string
}

export type CodeManifestRecordV1 = {
  manifest_id: string
  file_id: string
  manifest_kind: "tool" | "mcp_server" | "export_profile" | "schema" | "unknown"
  subject_id: string
  version?: string
  risk_level?: string
  requires_active_session?: boolean
  requires_hash_precondition?: boolean
  requires_path_lock?: boolean
  requires_approval?: boolean
  side_effects_json: unknown[]
  raw_json: unknown
}

export type CodeFindingRecordV1 = {
  finding_id: string
  severity: "info" | "warning" | "critical"
  category:
    | "export_completeness"
    | "unresolved_import"
    | "authority_mismatch"
    | "path_policy"
    | "hash_precondition"
    | "path_lock"
    | "receipt_integrity"
    | "journal_recovery"
    | "pglite_store"
    | "duckdb_projection"
    | "test_coverage"
    | "mcp_authority"
    | "provider_adapter"
    | "tribunus_import_violation"
    | "architecture_alignment"
  message: string
  path?: string
  symbol_id?: string
  source_anchor_json?: SourceAnchorV1
  recommended_fix?: string
  created_at: string
}

export type CodeIndexSnapshotRecordV1 = {
  snapshot_id: string
  created_at: string
  git_sha?: string
  git_branch?: string
  dirty: boolean
  file_count: number
  parsed_file_count: number
  symbol_count: number
  import_count: number
  reference_count: number
  test_count: number
  finding_count: number
  semantic_packet_path?: string
  source_packet_path?: string
}

export type CodeIndexEventRecordV1 = {
  event_id: string
  snapshot_id?: string
  event_type: string
  path?: string
  payload_json: Record<string, unknown>
  created_at: string
}

export type CodeIndexSnapshotV1 = {
  snapshot_id: string
  created_at: string
  repo_root: string
  git_sha?: string
  git_branch?: string
  dirty: boolean
  semantic_packet_path?: string
  source_packet_path?: string
  zip_path?: string
  zip_sha256?: string
  file_index: CodeFileRecordV1[]
  module_graph: unknown
  symbol_index: CodeSymbolRecordV1[]
  type_api_surface: unknown
  tool_kernel_ir: unknown
  pglite_duckdb_ir: unknown
  tests_and_ci_ir: unknown
  architecture_context: unknown
  review_findings: unknown
  manifest?: unknown
  imports: CodeImportRecordV1[]
  references: CodeReferenceRecordV1[]
  tests: CodeTestRecordV1[]
  authority_flows: CodeAuthorityFlowRecordV1[]
  manifests: CodeManifestRecordV1[]
  findings: CodeFindingRecordV1[]
  events: CodeIndexEventRecordV1[]
  warnings: string[]
}

export type RepoMapQueryV1 = {
  focus_paths?: string[]
  focus_symbols?: string[]
  focus_authority_roles?: string[]
  max_symbols?: number
  max_bytes?: number
  include_tests?: boolean
  include_architecture?: boolean
}

export type RepoMapResultV1 = {
  snapshot_id: string
  ranked_files: Array<{
    path: string
    score: number
    reason: string
    symbols: string[]
  }>
  ranked_symbols: Array<{
    symbol_id: string
    name: string
    path: string
    signature?: string
    score: number
    reason: string
  }>
  recommended_read_order: string[]
  warnings: string[]
}

export type SymbolLookupQueryV1 = {
  symbol_name?: string
  symbol_id?: string
  path?: string
  include_references?: boolean
  include_callers?: boolean
  include_tests?: boolean
}

export type SymbolLookupResultV1 = {
  symbols: Array<{
    symbol_id: string
    name: string
    kind: string
    path: string
    signature?: string
    anchor: Record<string, unknown>
    definitions: Record<string, unknown>[]
    references: Record<string, unknown>[]
    callers: Record<string, unknown>[]
    tests: string[]
  }>
}

export type ImpactAnalysisQueryV1 = {
  paths?: string[]
  symbols?: string[]
  proposed_change_summary?: string
  include_tests?: boolean
  include_manifests?: boolean
  include_migrations?: boolean
}

export type ImpactAnalysisResultV1 = {
  affected_files: string[]
  affected_symbols: string[]
  affected_tests: string[]
  affected_manifests: string[]
  affected_migrations: string[]
  authority_risks: Array<{
    risk: string
    severity: "info" | "warning" | "critical"
    evidence: Record<string, unknown>[]
  }>
  recommended_context: string[]
}

export type AuthorityAuditQueryV1 = {
  tool_ids?: string[]
}

export type AuthorityAuditResultV1 = {
  snapshot_id: string
  checks: Array<{
    check_id: string
    status: "pass" | "fail" | "warning"
    description: string
    evidence: Record<string, unknown>[]
  }>
  findings: Array<{
    severity: "info" | "warning" | "critical"
    category: string
    message: string
    path?: string
    recommended_fix?: string
  }>
  warnings: string[]
}

export type TestGapQueryV1 = {
  focus_tools?: string[]
}

export type TestGapReportV1 = {
  snapshot_id: string
  coverage_matrix: Array<{
    requirement_id: string
    requirement: string
    coverage_status: "covered" | "partial" | "missing"
    severity_if_missing: "info" | "warning" | "critical"
    covered_by_tests: string[]
  }>
  gaps: Array<{
    gap_id: string
    requirement_id: string
    severity: "info" | "warning" | "critical"
    missing_test: string
    recommended_test_file?: string
  }>
  warnings: string[]
}

export type StaleContextQueryV1 = {
  session_id: string
  paths?: string[]
  include_recent_effects?: boolean
}

export type StaleContextResultV1 = {
  stale_paths: Array<{
    path: string
    session_observed_sha256?: string
    current_sha256: string
    last_effect_receipt_id?: string
    last_effect_session_id?: string
  }>
  safe_to_continue: boolean
}

export type FileContextQueryV1 = {
  path: string
  include_neighbors?: boolean
  include_symbols?: boolean
  include_tests?: boolean
}

export type FileContextResultV1 = {
  file?: CodeFileRecordV1
  symbols: CodeSymbolRecordV1[]
  imports: CodeImportRecordV1[]
  tests: CodeTestRecordV1[]
  neighbors: string[]
  warnings: string[]
}

export type SemanticReviewExportInputV1 = {
  output_path?: string
  force?: boolean
  progress?: ReviewExportProgressSinkV1
}

export type SemanticReviewExportResultV1 = {
  snapshot_id: string
  zip_path: string
  zip_sha256: string
  warnings: string[]
  timings_ms?: ReviewExportTimingsV1
}

export type SourceReviewExportInputV1 = {
  output_path?: string
  force?: boolean
  progress?: ReviewExportProgressSinkV1
}

export type SourceReviewExportResultV1 = {
  snapshot_id: string
  zip_path: string
  zip_sha256: string
  warnings: string[]
  timings_ms?: ReviewExportTimingsV1
}

export type PairedReviewExportInputV1 = {
  semantic_output_path?: string
  source_output_path?: string
  force?: boolean
  progress?: ReviewExportProgressSinkV1
}

export type PairedReviewExportResultV1 = {
  snapshot_id: string
  semantic_zip_path: string
  semantic_zip_sha256: string
  source_zip_path: string
  source_zip_sha256: string
  warnings: string[]
  timings_ms?: ReviewExportTimingsV1
}

export type OmpCodeIntelligenceKernelV1 = {
  ensureIndexed(input?: {
    mode?: "full" | "incremental"
    reason?: string
  }): Promise<CodeIndexSnapshotV1>
  getCurrentSnapshot(): Promise<CodeIndexSnapshotV1 | null>
  refreshFiles(input: {
    paths: string[]
    reason: string
  }): Promise<CodeIndexSnapshotV1>
  getRepoMap(input: RepoMapQueryV1): Promise<RepoMapResultV1>
  lookupSymbol(input: SymbolLookupQueryV1): Promise<SymbolLookupResultV1>
  getFileContext(input: FileContextQueryV1): Promise<FileContextResultV1>
  analyzeImpact(input: ImpactAnalysisQueryV1): Promise<ImpactAnalysisResultV1>
  auditAuthority(input: AuthorityAuditQueryV1): Promise<AuthorityAuditResultV1>
  getTestGaps(input: TestGapQueryV1): Promise<TestGapReportV1>
  checkStaleContext(input: StaleContextQueryV1): Promise<StaleContextResultV1>
  exportSemanticReviewPacket(input: SemanticReviewExportInputV1): Promise<SemanticReviewExportResultV1>
  exportSourceReviewPacket(input: SourceReviewExportInputV1): Promise<SourceReviewExportResultV1>
  exportPairedReviewPacket(input: PairedReviewExportInputV1): Promise<PairedReviewExportResultV1>
}
