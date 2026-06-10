import { copyFileSync, existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type {
  AuthorityAuditQueryV1,
  AuthorityAuditResultV1,
  FileContextQueryV1,
  FileContextResultV1,
  ImpactAnalysisQueryV1,
  ImpactAnalysisResultV1,
  OmpCodeIntelligenceKernelV1,
  CodeImportRecordV1,
  PairedReviewExportInputV1,
  PairedReviewExportResultV1,
  RepoMapQueryV1,
  RepoMapResultV1,
  SemanticReviewExportInputV1,
  SemanticReviewExportResultV1,
  SourceReviewExportInputV1,
  SourceReviewExportResultV1,
  StaleContextQueryV1,
  StaleContextResultV1,
  SymbolLookupQueryV1,
  SymbolLookupResultV1,
  TestGapQueryV1,
  TestGapReportV1,
  CodeIndexSnapshotV1,
  CodeFileRecordV1,
  CodeSymbolRecordV1,
} from "./store/code-index-types.js"
import {
  ensureCodeIndexSnapshot,
  exportPairedPackets,
  exportSemanticPacket,
  exportSourcePacket,
  loadCurrentSnapshot,
  refreshSnapshotFiles,
} from "./snapshot.js"
import { getCodeIndexStore } from "./store/code-index-store.js"

const kernelCache = new Map<string, CodeIntelligenceKernelImpl>()

function importanceScore(value: CodeFileRecordV1["importance"]): number {
  return value === "authority_critical" ? 120 : value === "review_context" ? 60 : value === "background" ? 20 : 5
}

function categoryScore(value: string): number {
  const mapping: Record<string, number> = {
    omp_tool: 120,
    omp_kernel: 110,
    omp_manifest: 105,
    omp_test: 90,
    pglite_store: 100,
    duckdb_projection: 80,
    mcp_config: 75,
    package_source: 60,
    package_test: 55,
    schema: 50,
    adr: 35,
    board_artifact: 25,
    workflow: 30,
    script: 30,
    config: 35,
    doc: 15,
    asset: 1,
    excluded: -100,
  }
  return mapping[value] ?? 0
}

function pathMatches(path: string, focus: string): boolean {
  return path === focus || path.startsWith(`${focus}/`) || focus.startsWith(`${path}/`) || path.includes(focus) || focus.includes(path)
}

function fileAuthorityScore(file: CodeFileRecordV1, focusPaths: string[], focusRoles: string[], symbolIndex: CodeSymbolRecordV1[]): number {
  let score = importanceScore(file.importance) + categoryScore(file.category)
  if (focusPaths.some((focus) => pathMatches(file.path, focus))) score += 80
  const symbolRoles = symbolIndex.filter((symbol) => symbol.file_id === file.file_id).map((symbol) => symbol.authority_role).filter(Boolean) as string[]
  if (focusRoles.some((role) => symbolRoles.includes(role))) score += 75
  if (file.path.startsWith(".omp/tools/")) score += 35
  if (file.path.startsWith("packages/")) score += 20
  return score
}

function symbolScore(symbol: CodeSymbolRecordV1, fileScore: number, focusSymbols: string[]): number {
  let score = fileScore
  if (symbol.exported) score += 25
  if (symbol.authority_role) score += 50
  if (focusSymbols.includes(symbol.symbol_id) || focusSymbols.includes(symbol.name)) score += 100
  return score
}

function createFileMaps(snapshot: CodeIndexSnapshotV1) {
  const fileByPath = new Map(snapshot.file_index.map((file) => [file.path, file] as const))
  const symbolsByFile = new Map<string, CodeSymbolRecordV1[]>()
  for (const symbol of snapshot.symbol_index) {
    const list = symbolsByFile.get(symbol.file_id) ?? []
    list.push(symbol)
    symbolsByFile.set(symbol.file_id, list)
  }
  const importsByFile = new Map<string, typeof snapshot.imports>()
  for (const imp of snapshot.imports) {
    const list = importsByFile.get(imp.from_file_id) ?? []
    list.push(imp)
    importsByFile.set(imp.from_file_id, list)
  }
  const testsByFile = new Map<string, typeof snapshot.tests>()
  for (const test of snapshot.tests) {
    const list = testsByFile.get(test.file_id) ?? []
    list.push(test)
    testsByFile.set(test.file_id, list)
  }
  return { fileByPath, symbolsByFile, importsByFile, testsByFile }
}

function importedPaths(snapshot: CodeIndexSnapshotV1, path: string): string[] {
  const file = snapshot.file_index.find((entry) => entry.path === path)
  if (!file) return []
  return snapshot.imports
    .filter((edge) => edge.from_file_id === file.file_id && edge.resolved_path)
    .map((edge) => edge.resolved_path as string)
}

function importerPaths(snapshot: CodeIndexSnapshotV1, path: string): string[] {
  const file = snapshot.file_index.find((entry) => entry.path === path)
  if (!file) return []
  return snapshot.imports
    .filter((edge) => edge.resolved_path === path)
    .map((edge) => snapshot.file_index.find((entry) => entry.file_id === edge.from_file_id)?.path)
    .filter((value): value is string => Boolean(value))
}

function symbolAnchor(symbol: CodeSymbolRecordV1) {
  return {
    path: symbol.file_id.replace(/^file:/, ""),
    start_line: symbol.start_line,
    end_line: symbol.end_line,
    start_byte: symbol.start_byte,
    end_byte: symbol.end_byte,
    sha256: symbol.symbol_hash ?? "",
    language: symbol.authority_role ? "typescript" : "unknown",
    symbol_id: symbol.symbol_id,
  }
}

function testTargets(snapshot: CodeIndexSnapshotV1, fileId: string, symbol: CodeSymbolRecordV1): string[] {
  const targets = snapshot.tests
    .filter((test) => test.target_file_id === fileId || test.target_symbol_id === symbol.symbol_id)
    .map((test) => test.test_name)
  const byPath = snapshot.tests
    .filter((test) => test.file_id === fileId)
    .map((test) => test.test_name)
  return Array.from(new Set([...targets, ...byPath]))
}

function isResolvedImportStatus(status: CodeImportRecordV1["resolution_status"]): boolean {
  return status === "resolved" || status === "resolved_in_packet" || status === "external_package" || status === "builtin"
}

class CodeIntelligenceKernelImpl implements OmpCodeIntelligenceKernelV1 {
  constructor(private readonly repoRoot: string) {}

  private async snapshot(force = false): Promise<CodeIndexSnapshotV1> {
    if (force) return ensureCodeIndexSnapshot(this.repoRoot, true)
    const current = await loadCurrentSnapshot(this.repoRoot)
    if (current) return current
    return ensureCodeIndexSnapshot(this.repoRoot, false)
  }

  async ensureIndexed(input?: { mode?: "full" | "incremental"; reason?: string }): Promise<CodeIndexSnapshotV1> {
    const force = input?.mode !== "incremental"
    return ensureCodeIndexSnapshot(this.repoRoot, force)
  }

  async getCurrentSnapshot(): Promise<CodeIndexSnapshotV1 | null> {
    return loadCurrentSnapshot(this.repoRoot)
  }

  async refreshFiles(input: { paths: string[]; reason: string }): Promise<CodeIndexSnapshotV1> {
    return refreshSnapshotFiles(this.repoRoot, input.paths, input.reason)
  }

  async getRepoMap(input: RepoMapQueryV1): Promise<RepoMapResultV1> {
    const snapshot = await this.snapshot()
    const { fileByPath, symbolsByFile } = createFileMaps(snapshot)
    const focusPaths = input.focus_paths ?? []
    const focusSymbols = input.focus_symbols ?? []
    const focusRoles = input.focus_authority_roles ?? []
    const rankedFiles = snapshot.file_index
      .filter((file) => input.include_tests || file.category !== "omp_test")
      .map((file) => {
        const symbols = symbolsByFile.get(file.file_id) ?? []
        const score = fileAuthorityScore(file, focusPaths, focusRoles, snapshot.symbol_index)
        const reason = [
          file.importance,
          file.category,
          symbols.length > 0 ? `${symbols.length} symbols` : "no symbols",
          snapshot.imports.some((edge) => edge.from_file_id === file.file_id && !isResolvedImportStatus(edge.resolution_status)) ? "has import warnings" : "imports resolved",
        ].join("; ")
        return {
          path: file.path,
          score,
          reason,
          symbols: symbols.slice(0, input.max_symbols ?? 8).map((symbol) => symbol.name),
        }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(10, Math.min(input.max_bytes ? Math.ceil(input.max_bytes / 500) : 25, 50)))

    const rankedSymbols = snapshot.symbol_index
      .filter((symbol) => !input.include_tests || symbol.kind !== "test_case")
      .map((symbol) => {
        const file = fileByPath.get(snapshot.file_index.find((entry) => entry.file_id === symbol.file_id)?.path ?? "")
        const fileScore = file ? fileAuthorityScore(file, focusPaths, focusRoles, snapshot.symbol_index) : 0
        return {
          symbol_id: symbol.symbol_id,
          name: symbol.name,
          path: snapshot.file_index.find((entry) => entry.file_id === symbol.file_id)?.path ?? symbol.file_id.replace(/^file:/, ""),
          signature: symbol.signature,
          score: symbolScore(symbol, fileScore, focusSymbols),
          reason: symbol.authority_role ? `authority:${symbol.authority_role}` : symbol.exported ? "exported" : "internal",
        }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, input.max_symbols ?? 25)

    const recommended_read_order = Array.from(new Set([
      ...rankedFiles.slice(0, 12).map((file) => file.path),
      ...focusPaths,
    ])).slice(0, 20)

    return {
      snapshot_id: snapshot.snapshot_id,
      ranked_files: rankedFiles,
      ranked_symbols: rankedSymbols,
      recommended_read_order,
      warnings: snapshot.warnings,
    }
  }

  async lookupSymbol(input: SymbolLookupQueryV1): Promise<SymbolLookupResultV1> {
    const snapshot = await this.snapshot()
    const { fileByPath } = createFileMaps(snapshot)
    const candidates = snapshot.symbol_index.filter((symbol) => {
      if (input.symbol_id && symbol.symbol_id === input.symbol_id) return true
      if (input.symbol_name && symbol.name === input.symbol_name) return true
      if (input.path && fileByPath.get(input.path)?.file_id === symbol.file_id) return true
      return !input.symbol_id && !input.symbol_name && !input.path
    })

    return {
      symbols: candidates.map((symbol) => {
        const filePath = snapshot.file_index.find((entry) => entry.file_id === symbol.file_id)?.path ?? symbol.file_id.replace(/^file:/, "")
        const refs = snapshot.references.filter((ref) => ref.from_symbol_id === symbol.symbol_id || ref.to_symbol_id === symbol.symbol_id)
        const callers = input.include_callers
          ? snapshot.imports
              .filter((imp) => imp.resolved_path === filePath)
              .map((imp) => ({ path: snapshot.file_index.find((entry) => entry.file_id === imp.from_file_id)?.path ?? imp.from_file_id }))
          : []
        const tests = input.include_tests ? testTargets(snapshot, symbol.file_id, symbol) : []
        return {
          symbol_id: symbol.symbol_id,
          name: symbol.name,
          kind: symbol.kind,
          path: filePath,
          signature: symbol.signature,
          anchor: symbolAnchor(symbol),
          definitions: input.include_references ? refs.filter((ref) => ref.reference_kind === "definition").map((ref) => ({ path: filePath, start_line: ref.start_line, end_line: ref.end_line, confidence: ref.confidence })) : [],
          references: input.include_references ? refs.map((ref) => ({ path: filePath, kind: ref.reference_kind, start_line: ref.start_line, end_line: ref.end_line, confidence: ref.confidence })) : [],
          callers: input.include_callers ? callers : [],
          tests,
        }
      }),
    }
  }

  async getFileContext(input: FileContextQueryV1): Promise<FileContextResultV1> {
    const snapshot = await this.snapshot()
    const file = snapshot.file_index.find((entry) => entry.path === input.path)
    const symbols = file ? snapshot.symbol_index.filter((symbol) => symbol.file_id === file.file_id) : []
    const imports = file ? snapshot.imports.filter((imp) => imp.from_file_id === file.file_id) : []
    const tests = file ? snapshot.tests.filter((test) => test.file_id === file.file_id || test.target_file_id === file.file_id) : []
    const neighbors = input.include_neighbors
      ? Array.from(new Set([...importedPaths(snapshot, input.path), ...importerPaths(snapshot, input.path)])).filter((path): path is string => Boolean(path))
      : []

    return {
      file,
      symbols: input.include_symbols === false ? [] : symbols,
      imports,
      tests: input.include_tests === false ? [] : tests,
      neighbors,
      warnings: snapshot.warnings,
    }
  }

  async analyzeImpact(input: ImpactAnalysisQueryV1): Promise<ImpactAnalysisResultV1> {
    const snapshot = await this.snapshot()
    const { fileByPath } = createFileMaps(snapshot)
    const focusFiles = new Set<string>(input.paths ?? [])
    for (const symbolName of input.symbols ?? []) {
      const symbol = snapshot.symbol_index.find((entry) => entry.symbol_id === symbolName || entry.name === symbolName)
      if (symbol) {
        const path = snapshot.file_index.find((entry) => entry.file_id === symbol.file_id)?.path
        if (path) focusFiles.add(path)
      }
    }

    const closure = new Set<string>(focusFiles)
    for (const path of Array.from(focusFiles)) {
      for (const neighbor of [...importedPaths(snapshot, path), ...importerPaths(snapshot, path)]) {
        closure.add(neighbor)
      }
    }

    const affectedFiles = Array.from(closure)
    const affectedSymbols = snapshot.symbol_index
      .filter((symbol) => affectedFiles.includes(snapshot.file_index.find((entry) => entry.file_id === symbol.file_id)?.path ?? ""))
      .map((symbol) => symbol.symbol_id)
    const affectedTests = snapshot.tests
      .filter((test) => affectedFiles.includes(snapshot.file_index.find((entry) => entry.file_id === test.file_id)?.path ?? "") || (test.target_file_id ? affectedFiles.includes(snapshot.file_index.find((entry) => entry.file_id === test.target_file_id)?.path ?? "") : false))
      .map((test) => test.test_id)
    const affectedManifests = snapshot.manifests
      .filter((manifest) => affectedFiles.includes(manifest.file_id.replace(/^file:/, "")) || (manifest.subject_id && focusFiles.has(`.omp/tools/manifests/${manifest.subject_id}.v1.json`)))
      .map((manifest) => manifest.manifest_id)
    const affectedMigrations = snapshot.file_index
      .filter((file) => file.path.startsWith(".omp/tools/_lib/store/migrations/") && (focusFiles.size === 0 || affectedFiles.includes(file.path) || input.include_migrations))
      .map((file) => file.path)

    const authorityRisks = affectedFiles.flatMap((path) => {
      const file = fileByPath.get(path)
      if (!file) return []
      const risks: Array<{ risk: string; severity: "info" | "warning" | "critical"; evidence: Record<string, unknown>[] }> = []
      if (file.importance === "authority_critical" && file.category === "omp_tool") {
        risks.push({ risk: `Editing ${path} may affect governed tool behavior.`, severity: "warning", evidence: [{ path }] })
      }
      if (snapshot.imports.some((imp) => imp.from_file_id === file.file_id && !isResolvedImportStatus(imp.resolution_status))) {
        risks.push({ risk: `Import closure for ${path} contains unresolved edges.`, severity: "warning", evidence: [{ path }] })
      }
      return risks
    })

    return {
      affected_files: affectedFiles,
      affected_symbols: affectedSymbols,
      affected_tests: affectedTests,
      affected_manifests: affectedManifests,
      affected_migrations: affectedMigrations,
      authority_risks: authorityRisks,
      recommended_context: Array.from(new Set([
        ...affectedFiles,
        ...snapshot.file_index.filter((file) => file.importance === "authority_critical").slice(0, 8).map((file) => file.path),
      ])).slice(0, 20),
    }
  }

  async auditAuthority(input: AuthorityAuditQueryV1): Promise<AuthorityAuditResultV1> {
    const snapshot = await this.snapshot()
    const toolKernel = snapshot.tool_kernel_ir as any
    const pglite = snapshot.pglite_duckdb_ir as any
    const moduleGraph = snapshot.module_graph as any
    const tools = Array.isArray(toolKernel.tools) ? toolKernel.tools : []
    const manifestsByPath = new Map(snapshot.manifests.map((manifest) => [manifest.file_id.replace(/^file:/, ""), manifest] as const))

    const writeTools = tools.filter((tool: any) => String(tool.authority_profile?.risk_level ?? "read") !== "read")
    const findTool = (toolId: string) => tools.find((tool: any) => String(tool.tool_id) === toolId)

    const checks: AuthorityAuditResultV1["checks"] = [
      {
        check_id: "write_tools_require_hash",
        description: "Write tools require hash preconditions.",
        status: writeTools.every((tool: any) => Boolean(tool.authority_profile?.requires_hash_precondition)) ? "pass" : "fail",
        evidence: writeTools.map((tool: any) => ({ tool_id: tool.tool_id })),
      },
      {
        check_id: "write_tools_require_path_lock",
        description: "Write tools require path locks.",
        status: writeTools.every((tool: any) => Boolean(tool.authority_profile?.requires_path_lock)) ? "pass" : "fail",
        evidence: writeTools.map((tool: any) => ({ tool_id: tool.tool_id })),
      },
      {
        check_id: "hash_verified_after_lock",
        description: "Hash is verified after lock acquisition.",
        status: tools.filter((tool: any) => ["text_replace", "batch_edit"].includes(String(tool.tool_id))).every((tool: any) => tool.safety_properties?.verifies_hash_after_lock) ? "pass" : "fail",
        evidence: tools.filter((tool: any) => ["text_replace", "batch_edit"].includes(String(tool.tool_id))).map((tool: any) => ({ tool_id: tool.tool_id })),
      },
      {
        check_id: "locks_released_in_finally",
        description: "Locks are released in finally.",
        status: tools.filter((tool: any) => ["text_replace", "batch_edit"].includes(String(tool.tool_id))).every((tool: any) => tool.safety_properties?.releases_locks_in_finally) ? "pass" : "fail",
        evidence: tools.filter((tool: any) => ["text_replace", "batch_edit"].includes(String(tool.tool_id))).map((tool: any) => ({ tool_id: tool.tool_id })),
      },
      {
        check_id: "mutation_records_receipt_diff_event_store",
        description: "Mutations record receipt, diff, audit event, and PGlite mutation.",
        status: tools.filter((tool: any) => ["text_replace", "batch_edit"].includes(String(tool.tool_id))).every((tool: any) => tool.safety_properties?.records_receipt && tool.safety_properties?.records_diff && tool.safety_properties?.records_audit_event && tool.safety_properties?.records_pglite_mutation) ? "pass" : "fail",
        evidence: tools.filter((tool: any) => ["text_replace", "batch_edit"].includes(String(tool.tool_id))).map((tool: any) => ({ tool_id: tool.tool_id })),
      },
      {
        check_id: "duckdb_not_in_write_path",
        description: "DuckDB is not in the write path.",
        status: pglite?.duckdb?.write_path_usage?.duckdb_used_in_write_path ? "fail" : "pass",
        evidence: [{ path: ".omp/tools/_lib/analytics/duckdb-projector.ts" }],
      },
      {
        check_id: "provider_adapters_do_not_own_authority",
        description: "Provider adapters do not own authority.",
        status: Array.isArray(toolKernel.provider_adapters) ? toolKernel.provider_adapters.every((entry: any) => !entry.owns_authority) : "fail",
        evidence: Array.isArray(toolKernel.provider_adapters) ? toolKernel.provider_adapters.map((entry: any) => ({ path: entry.path })) : [],
      },
      {
        check_id: "omp_tools_do_not_import_tribunus",
        description: "OMP tools do not import Tribunus package source.",
        status: Array.isArray(moduleGraph.edges) ? moduleGraph.edges.filter((edge: any) => String(edge.from_path ?? "").startsWith(".omp/tools/") && String(edge.resolved_path ?? "").startsWith("packages/")).length === 0 ? "pass" : "fail" : "fail",
        evidence: Array.isArray(moduleGraph.edges) ? moduleGraph.edges.filter((edge: any) => String(edge.from_path ?? "").startsWith(".omp/tools/") && String(edge.resolved_path ?? "").startsWith("packages/")).map((edge: any) => ({ from_path: edge.from_path, resolved_path: edge.resolved_path })) : [],
      },
      {
        check_id: "text_replace_risk_matches_manifest",
        description: "text_replace risk matches its manifest.",
        status: (() => {
          const tool = findTool("text_replace") as any
          const manifest = manifestsByPath.get(".omp/tools/manifests/text_replace.v1.json") as any
          return tool && manifest && tool.authority_profile?.risk_level === manifest.risk_level ? "pass" : "fail"
        })(),
        evidence: [{ tool_id: "text_replace" }],
      },
      {
        check_id: "batch_edit_risk_matches_manifest",
        description: "batch_edit risk matches its manifest.",
        status: (() => {
          const tool = findTool("batch_edit") as any
          const manifest = manifestsByPath.get(".omp/tools/manifests/batch_edit.v1.json") as any
          return tool && manifest && tool.authority_profile?.risk_level === manifest.risk_level ? "pass" : "fail"
        })(),
        evidence: [{ tool_id: "batch_edit" }],
      },
    ]

    const findings: AuthorityAuditResultV1["findings"] = []
    for (const check of checks) {
      if (check.status === "pass") continue
      findings.push({
        severity: "warning",
        category: "authority_mismatch",
        message: `${check.check_id} failed`,
        path: undefined,
        recommended_fix: `Review ${check.check_id} evidence in the semantic packet.`,
      })
    }

    return {
      snapshot_id: snapshot.snapshot_id,
      checks,
      findings,
      warnings: snapshot.warnings,
    }
  }

  async getTestGaps(input: TestGapQueryV1): Promise<TestGapReportV1> {
    const snapshot = await this.snapshot()
    const testsIr = snapshot.tests_and_ci_ir as any
    const coverage = Array.isArray(testsIr.coverage_matrix) ? testsIr.coverage_matrix : []
    const testGaps = Array.isArray(testsIr.test_gaps) ? testsIr.test_gaps : []
    if (!input.focus_tools?.length) {
      return {
        snapshot_id: snapshot.snapshot_id,
        coverage_matrix: coverage,
        gaps: testGaps,
        warnings: snapshot.warnings,
      }
    }
    const filteredCoverage = coverage.filter((row: any) => input.focus_tools!.some((tool) => String(row.requirement ?? "").includes(tool) || String(row.requirement_id ?? "").includes(tool)))
    const filteredGaps = testGaps.filter((row: any) => input.focus_tools!.some((tool) => String(row.requirement ?? "").includes(tool) || String(row.requirement_id ?? "").includes(tool)))
    return {
      snapshot_id: snapshot.snapshot_id,
      coverage_matrix: filteredCoverage,
      gaps: filteredGaps,
      warnings: snapshot.warnings,
    }
  }

  async checkStaleContext(input: StaleContextQueryV1): Promise<StaleContextResultV1> {
    const snapshot = await this.snapshot()
    const sessionPath = resolve(this.repoRoot, ".omp/state/code-intelligence/session-observations", `${input.session_id}.json`)
    const observations = existsSync(sessionPath) ? JSON.parse(readFileSync(sessionPath, "utf8")) as Record<string, string> : {}
    const paths = input.paths ?? Object.keys(observations)
    const stale_paths = paths.flatMap((path) => {
      const current = snapshot.file_index.find((file) => file.path === path)
      if (!current) return []
      const observed = observations[path]
      if (!observed || observed === current.sha256) return []
      return [{
        path,
        session_observed_sha256: observed,
        current_sha256: current.sha256,
        last_effect_receipt_id: undefined,
        last_effect_session_id: input.session_id,
      }]
    })
    return {
      stale_paths,
      safe_to_continue: stale_paths.length === 0,
    }
  }

  async exportSemanticReviewPacket(input: SemanticReviewExportInputV1): Promise<SemanticReviewExportResultV1> {
    const { snapshot, zipPath, zipSha256, warnings, timings_ms } = await exportSemanticPacket(this.repoRoot, undefined, {
      force: input.force ?? false,
      progress: input.progress,
    })
    const outputPath = input.output_path ?? zipPath
    if (outputPath !== zipPath) {
      copyFileSync(zipPath, outputPath)
    }
    await getCodeIndexStore(this.repoRoot).recordPacket({
      snapshot_id: snapshot.snapshot_id,
      packet_kind: "semantic",
      zip_path: outputPath,
      zip_sha256: zipSha256,
      warnings,
    })
    return {
      snapshot_id: snapshot.snapshot_id,
      zip_path: outputPath,
      zip_sha256: zipSha256,
      warnings,
      timings_ms,
    }
  }

  async exportSourceReviewPacket(input: SourceReviewExportInputV1): Promise<SourceReviewExportResultV1> {
    const { snapshot, zipPath, zipSha256, warnings, timings_ms } = await exportSourcePacket(this.repoRoot, undefined, {
      force: input.force ?? false,
      progress: input.progress,
    })
    const outputPath = input.output_path ?? zipPath
    if (outputPath !== zipPath) {
      copyFileSync(zipPath, outputPath)
    }
    await getCodeIndexStore(this.repoRoot).recordPacket({
      snapshot_id: snapshot.snapshot_id,
      packet_kind: "source",
      zip_path: outputPath,
      zip_sha256: zipSha256,
      warnings,
    })
    return {
      snapshot_id: snapshot.snapshot_id,
      zip_path: outputPath,
      zip_sha256: zipSha256,
      warnings,
      timings_ms,
    }
  }

  async exportPairedReviewPacket(input: PairedReviewExportInputV1): Promise<PairedReviewExportResultV1> {
    const paired = await exportPairedPackets(this.repoRoot, { progress: input.progress })
    const store = getCodeIndexStore(this.repoRoot)
    const semanticZipPath = input.semantic_output_path ?? paired.semanticZipPath
    const sourceZipPath = input.source_output_path ?? paired.sourceZipPath
    if (semanticZipPath !== paired.semanticZipPath) {
      copyFileSync(paired.semanticZipPath, semanticZipPath)
    }
    if (sourceZipPath !== paired.sourceZipPath) {
      copyFileSync(paired.sourceZipPath, sourceZipPath)
    }
    await store.recordPacket({
      snapshot_id: paired.snapshot.snapshot_id,
      packet_kind: "paired",
      zip_path: semanticZipPath,
      zip_sha256: paired.semanticZipSha256,
      warnings: paired.warnings,
    })
    return {
      snapshot_id: paired.snapshot.snapshot_id,
      semantic_zip_path: semanticZipPath,
      semantic_zip_sha256: paired.semanticZipSha256,
      source_zip_path: sourceZipPath,
      source_zip_sha256: paired.sourceZipSha256,
      warnings: paired.warnings,
      timings_ms: paired.timings_ms,
    }
  }
}

export function getCodeIntelligenceKernel(repoRoot: string): OmpCodeIntelligenceKernelV1 {
  let kernel = kernelCache.get(repoRoot)
  if (!kernel) {
    kernel = new CodeIntelligenceKernelImpl(repoRoot)
    kernelCache.set(repoRoot, kernel)
  }
  return kernel
}
