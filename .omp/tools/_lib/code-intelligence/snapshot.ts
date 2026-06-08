import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"
import { z } from "zod"
import codeReviewExportFactory from "../../code_review_export.js"
import { createReviewExportTimeline, type ReviewExportProgressEventV1, type ReviewExportProgressSinkV1, type ReviewExportTimingsV1 } from "../review-export/progress.js"
import { createZipCliArchiveBackend } from "../review-export/archive.js"
import { getCodeIndexStore } from "./store/code-index-store.js"
import type {
  CodeAuthorityFlowRecordV1,
  CodeFileRecordV1,
  CodeFindingRecordV1,
  CodeImportRecordV1,
  CodeIndexEventRecordV1,
  CodeIndexSnapshotV1,
  CodeManifestRecordV1,
  CodeReferenceRecordV1,
  CodeSymbolRecordV1,
  CodeTestRecordV1,
} from "./store/code-index-types.js"

type PacketArtifactMap = {
  manifest: Record<string, unknown>
  fileIndex: Record<string, unknown>
  moduleGraph: Record<string, unknown>
  symbolIndex: Record<string, unknown>
  typeApiSurface: Record<string, unknown>
  toolKernelIr: Record<string, unknown>
  pgliteDuckdbIr: Record<string, unknown>
  testsAndCiIr: Record<string, unknown>
  architectureContext: Record<string, unknown>
  reviewFindings: Record<string, unknown>
}

function gitExec(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000 })
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

function readPacketJson(zipPath: string, entry: string): Record<string, unknown> {
  const result = spawnSync("unzip", ["-p", zipPath, `tribunus-gemini-ir/${entry}`], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 50 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to read ${entry} from ${zipPath}`)
  }
  return JSON.parse(result.stdout) as Record<string, unknown>
}

function readPacketEntryBytes(zipPath: string, entry: string): Buffer {
  return readZipEntryBytes(zipPath, `tribunus-gemini-ir/${entry}`)
}

function readZipEntryBytes(zipPath: string, entryPath: string): Buffer {
  const result = spawnSync("unzip", ["-p", zipPath, entryPath], {
    timeout: 120000,
    maxBuffer: 50 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString() || result.stdout?.toString() || `Failed to read ${entryPath} from ${zipPath}`)
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? [])
}

function mapInclusion(inclusion: unknown): CodeFileRecordV1["inclusion_status"] {
  return inclusion === "excluded" ? "excluded" : inclusion === "indexed_only" ? "indexed_only" : "included"
}

function mapParseStatus(status: unknown): CodeFileRecordV1["parse_status"] {
  return status === "parse_error" || status === "unsupported_language" || status === "not_source" ? status : "parsed"
}

function languageFromAnchor(anchor: unknown): string | undefined {
  if (!anchor || typeof anchor !== "object") return undefined
  const value = (anchor as Record<string, unknown>).language
  return typeof value === "string" ? value : undefined
}

function pathFromAnchor(anchor: unknown): string | undefined {
  if (!anchor || typeof anchor !== "object") return undefined
  const value = (anchor as Record<string, unknown>).path
  return typeof value === "string" ? value : undefined
}

function lineFromAnchor(anchor: unknown, key: "start_line" | "end_line"): number | undefined {
  if (!anchor || typeof anchor !== "object") return undefined
  const value = (anchor as Record<string, unknown>)[key]
  return typeof value === "number" ? value : undefined
}

function mapFileRecord(file: Record<string, unknown>): CodeFileRecordV1 {
  const path = String(file.path ?? "")
  return {
    file_id: String(file.file_id ?? `file:${path}`),
    path,
    language: typeof file.language === "string" && file.language !== "unknown" ? file.language : undefined,
    category: String(file.category ?? "unknown"),
    sha256: String(file.sha256 ?? ""),
    size_bytes: Number(file.size_bytes ?? 0),
    line_count: typeof file.line_count === "number" ? file.line_count : undefined,
    importance: (file.importance as CodeFileRecordV1["importance"]) ?? "background",
    inclusion_status: mapInclusion(file.inclusion ?? file.inclusion_status),
    parse_status: mapParseStatus(file.parse_status),
    parse_error: typeof file.parse_error === "string" ? file.parse_error : undefined,
    indexed_at: typeof file.indexed_at === "string" ? file.indexed_at : new Date().toISOString(),
    last_seen_at: typeof file.last_seen_at === "string" ? file.last_seen_at : new Date().toISOString(),
  }
}

function inferAuthorityRole(path: string, name: string): CodeSymbolRecordV1["authority_role"] | undefined {
  const probe = `${path} ${name}`.toLowerCase()
  if (probe.includes("path-policy")) return "path_policy"
  if (probe.includes("hash") || probe.includes("sha256")) return "hash_precondition"
  if (probe.includes("path-lock") || probe.includes("lock")) return "path_lock"
  if (probe.includes("receipt")) return "receipt_writer"
  if (probe.includes("diff")) return "diff_writer"
  if (probe.includes("audit")) return "audit_writer"
  if (probe.includes("journal")) return "journal_writer"
  if (probe.includes("pglite-store") || probe.includes("store")) return "store_transaction"
  if (probe.includes("recover")) return "recovery"
  if (probe.includes("redact")) return "redaction"
  if (probe.includes("manifest")) return "manifest_generator"
  if (probe.includes("adapter")) return "provider_adapter"
  if (probe.includes("semantic")) return "semantic_indexer"
  if (probe.includes("review")) return "review_exporter"
  return undefined
}

function mapSymbolRecord(symbol: Record<string, unknown>, fileIndexByPath: Map<string, CodeFileRecordV1>): CodeSymbolRecordV1 {
  const anchor = symbol.anchor as Record<string, unknown> | undefined
  const path = pathFromAnchor(anchor) ?? String(symbol.path ?? "")
  const file = fileIndexByPath.get(path)
  const signature = typeof symbol.signature === "string" ? symbol.signature : undefined
  const name = String(symbol.name ?? "")
  const kind = String(symbol.kind ?? "unknown") as CodeSymbolRecordV1["kind"]
  const id = String(symbol.symbol_id ?? `symbol:${path}#${name}`)
  return {
    symbol_id: id,
    file_id: file?.file_id ?? `file:${path}`,
    name,
    kind,
    exported: Boolean(symbol.exported),
    start_line: lineFromAnchor(anchor, "start_line"),
    end_line: lineFromAnchor(anchor, "end_line"),
    start_byte: typeof anchor?.start_byte === "number" ? anchor.start_byte : undefined,
    end_byte: typeof anchor?.end_byte === "number" ? anchor.end_byte : undefined,
    signature,
    doc_summary: undefined,
    authority_role: inferAuthorityRole(path, name),
    symbol_hash: signature ? symbolHash(path, name, kind, signature) : undefined,
    created_at: typeof symbol.created_at === "string" ? symbol.created_at : new Date().toISOString(),
  }
}

function symbolHash(path: string, name: string, kind: string, signature: string): string {
  return createHash("sha256").update(`${path}|${name}|${kind}|${signature}`, "utf8").digest("hex")
}

function mapImportRecord(
  edge: Record<string, unknown>,
  fileIndexByPath: Map<string, CodeFileRecordV1>,
  index: number,
): CodeImportRecordV1 {
  const path = String(edge.from_path ?? "")
  const resolvedPath = typeof edge.resolved_path === "string" ? edge.resolved_path : undefined
  const resolvedFileId = resolvedPath ? fileIndexByPath.get(resolvedPath)?.file_id : undefined
  return {
    import_id: `import:${index}:${path}->${String(edge.specifier ?? "")}:${String(edge.import_kind ?? "unknown")}`,
    from_file_id: fileIndexByPath.get(path)?.file_id ?? `file:${path}`,
    specifier: String(edge.specifier ?? ""),
    import_kind: (edge.import_kind as CodeImportRecordV1["import_kind"]) ?? "unknown",
    resolution_status: (edge.resolution_status as CodeImportRecordV1["resolution_status"]) ?? "unresolved",
    resolved_file_id: resolvedFileId,
    resolved_path: resolvedPath,
    reason: typeof edge.reason === "string" ? edge.reason : undefined,
    start_line: typeof edge.start_line === "number" ? edge.start_line : undefined,
    end_line: typeof edge.end_line === "number" ? edge.end_line : undefined,
  }
}

function mapReferenceRecords(
  symbols: CodeSymbolRecordV1[],
  imports: CodeImportRecordV1[],
): CodeReferenceRecordV1[] {
  const resolvedStatuses = new Set<CodeImportRecordV1["resolution_status"]>([
    "resolved",
    "resolved_in_packet",
    "resolved_not_embedded",
    "resolved_not_included",
    "ts_js_extension_remap",
  ])

  const definitionRefs = symbols.map((symbol) => ({
    reference_id: `ref:def:${symbol.symbol_id}`,
    from_file_id: symbol.file_id,
    from_symbol_id: symbol.symbol_id,
    to_symbol_id: symbol.symbol_id,
    reference_kind: "definition" as const,
    start_line: symbol.start_line,
    end_line: symbol.end_line,
    confidence: "semantic" as const,
  }))

  const importRefs = imports.map((imp) => ({
    reference_id: `ref:import:${imp.import_id}`,
    from_file_id: imp.from_file_id,
    from_symbol_id: undefined,
    to_symbol_id: undefined,
    reference_kind: "import" as const,
    start_line: imp.start_line,
    end_line: imp.end_line,
    confidence: resolvedStatuses.has(imp.resolution_status) ? "semantic" as const : "heuristic" as const,
  }))

  return [...definitionRefs, ...importRefs]
}

function mapTestRecord(
  test: Record<string, unknown>,
  fileIndexByPath: Map<string, CodeFileRecordV1>,
  symbolByName: Map<string, CodeSymbolRecordV1>,
  repoRoot: string,
): CodeTestRecordV1 {
  const path = String(test.path ?? "")
  const relPath = path.startsWith(repoRoot) ? relative(repoRoot, path).replace(/\\/g, "/") : path
  const file = fileIndexByPath.get(relPath) ?? fileIndexByPath.get(path)
  const assertions = Array.isArray(test.assertions) ? test.assertions as Array<Record<string, unknown>> : []
  const primaryAssertion = assertions[0]
  const targetFilePath = Array.isArray(test.target_files) ? test.target_files[0] : undefined
  const targetFile = typeof targetFilePath === "string" ? fileIndexByPath.get(targetFilePath) : undefined
  const targetSymbolName = Array.isArray(test.target_symbols) ? test.target_symbols[0] : undefined
  return {
    test_id: String(test.test_id ?? `test:${path}`),
    file_id: file?.file_id ?? `file:${relPath}`,
    suite_name: typeof test.suite_name === "string" ? test.suite_name : undefined,
    test_name: String(test.test_name ?? ""),
    framework: String(test.framework ?? "bun_test"),
    target_file_id: targetFile?.file_id,
    target_symbol_id: typeof targetSymbolName === "string" ? symbolByName.get(targetSymbolName)?.symbol_id : undefined,
    assertion_kind: typeof primaryAssertion?.kind === "string" ? primaryAssertion.kind as CodeTestRecordV1["assertion_kind"] : undefined,
    start_line: test.source && typeof (test.source as Record<string, unknown>).anchor === "object"
      ? lineFromAnchor((test.source as Record<string, unknown>).anchor, "start_line")
      : undefined,
    end_line: test.source && typeof (test.source as Record<string, unknown>).anchor === "object"
      ? lineFromAnchor((test.source as Record<string, unknown>).anchor, "end_line")
      : undefined,
    confidence: "semantic",
  }
}

function mapFindingRecord(finding: Record<string, unknown>): CodeFindingRecordV1 {
  const evidence = Array.isArray(finding.evidence) ? finding.evidence as Array<Record<string, unknown>> : []
  const firstEvidence = evidence[0]
  return {
    finding_id: String(finding.finding_id ?? "finding:unknown"),
    severity: (finding.severity as CodeFindingRecordV1["severity"]) ?? "info",
    category: String(finding.category ?? "architecture_alignment") as CodeFindingRecordV1["category"],
    message: String(finding.message ?? ""),
    path: typeof finding.path === "string" ? finding.path : pathFromAnchor(firstEvidence),
    symbol_id: typeof finding.symbol_id === "string" ? finding.symbol_id : typeof firstEvidence?.symbol_id === "string" ? firstEvidence.symbol_id : undefined,
    source_anchor_json: firstEvidence ? {
      path: String(firstEvidence.path ?? pathFromAnchor(firstEvidence) ?? ""),
      start_line: lineFromAnchor(firstEvidence, "start_line"),
      end_line: lineFromAnchor(firstEvidence, "end_line"),
      sha256: String(firstEvidence.sha256 ?? ""),
      language: languageFromAnchor(firstEvidence),
      symbol_id: typeof firstEvidence.symbol_id === "string" ? firstEvidence.symbol_id : undefined,
    } : undefined,
    recommended_fix: typeof finding.recommended_fix === "string" ? finding.recommended_fix : undefined,
    created_at: new Date().toISOString(),
  }
}

function mapAuthorityFlow(
  toolId: string,
  step: Record<string, unknown>,
  sourcePath: string,
): CodeAuthorityFlowRecordV1 {
  const anchor = step.anchor as Record<string, unknown> | undefined
  return {
    flow_id: `flow:${toolId}:${String(step.step ?? step.symbol_id ?? "unknown")}`,
    tool_id: toolId,
    file_id: `file:${sourcePath}`,
    flow_step: String(step.step ?? "validate_input") as CodeAuthorityFlowRecordV1["flow_step"],
    detected: Boolean(step.detected),
    symbol_id: typeof step.symbol_id === "string" ? step.symbol_id : undefined,
    start_line: lineFromAnchor(anchor, "start_line"),
    end_line: lineFromAnchor(anchor, "end_line"),
    confidence: (step.confidence as CodeAuthorityFlowRecordV1["confidence"]) ?? "heuristic",
    notes: typeof step.notes === "string" ? step.notes : undefined,
  }
}

function mapManifestFromFile(path: string, raw: Record<string, unknown>): CodeManifestRecordV1 | null {
  if (path.startsWith(".omp/tools/manifests/")) {
    const authority = raw.authority as Record<string, unknown> | undefined
    return {
      manifest_id: `manifest:${path}`,
      file_id: `file:${path}`,
      manifest_kind: "tool",
      subject_id: String(raw.tool_id ?? raw.name ?? basename(path)),
      version: typeof raw.version === "string" ? raw.version : undefined,
      risk_level: typeof authority?.risk_level === "string" ? authority.risk_level : undefined,
      requires_active_session: typeof authority?.requires_active_session === "boolean" ? authority.requires_active_session : undefined,
      requires_hash_precondition: typeof authority?.requires_hash_precondition === "boolean" ? authority.requires_hash_precondition : undefined,
      requires_path_lock: typeof authority?.requires_path_lock === "boolean" ? authority.requires_path_lock : undefined,
      requires_approval: typeof authority?.requires_approval === "boolean" ? authority.requires_approval : undefined,
      side_effects_json: Array.isArray(authority?.side_effects) ? authority.side_effects : [],
      raw_json: raw,
    }
  }

  if (path === ".omp/mcp-manifest.v1.json") {
    return {
      manifest_id: `manifest:${path}`,
      file_id: `file:${path}`,
      manifest_kind: "mcp_server",
      subject_id: "mcp_manifest",
      version: typeof raw.version === "string" ? raw.version : undefined,
      risk_level: undefined,
      requires_active_session: undefined,
      requires_hash_precondition: undefined,
      requires_path_lock: undefined,
      requires_approval: undefined,
      side_effects_json: [],
      raw_json: raw,
    }
  }

  return null
}

function buildManifestRecords(repoRoot: string): CodeManifestRecordV1[] {
  const records: CodeManifestRecordV1[] = []
  const toolManifestDir = resolve(repoRoot, ".omp/tools/manifests")
  if (existsSync(toolManifestDir)) {
    for (const entry of readdirSync(toolManifestDir).filter((file) => file.endsWith(".json")).sort()) {
      const path = `.omp/tools/manifests/${entry}`
      const raw = JSON.parse(readFileSync(resolve(toolManifestDir, entry), "utf8")) as Record<string, unknown>
      const record = mapManifestFromFile(path, raw)
      if (record) records.push(record)
    }
  }

  const mcpManifestPath = resolve(repoRoot, ".omp/mcp-manifest.v1.json")
  if (existsSync(mcpManifestPath)) {
    const raw = JSON.parse(readFileSync(mcpManifestPath, "utf8")) as Record<string, unknown>
    const record = mapManifestFromFile(".omp/mcp-manifest.v1.json", raw)
    if (record) records.push(record)
  }

  const exportManifestPath = resolve(repoRoot, ".omp/tools/code_review_export.ts")
  if (existsSync(exportManifestPath)) {
    const raw = {
      schema: "omp.export_profile.v1",
      profile: "gemini_structured_ir_v1",
      source: ".omp/tools/code_review_export.ts",
    }
    records.push({
      manifest_id: "manifest:.omp/tools/code_review_export.ts#gemini_structured_ir_v1",
      file_id: "file:.omp/tools/code_review_export.ts",
      manifest_kind: "export_profile",
      subject_id: "gemini_structured_ir_v1",
      version: "1",
      risk_level: "review_context",
      requires_active_session: false,
      requires_hash_precondition: false,
      requires_path_lock: false,
      requires_approval: false,
      side_effects_json: [],
      raw_json: raw,
    })
  }

  return records
}

function buildEvents(snapshotId: string): CodeIndexEventRecordV1[] {
  return [
    {
      event_id: `event:${snapshotId}:materialized`,
      snapshot_id: snapshotId,
      event_type: "snapshot_materialized",
      path: undefined,
      payload_json: { snapshot_id: snapshotId },
      created_at: new Date().toISOString(),
    },
  ]
}

function normalizeToolContracts(toolKernel: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(toolKernel.tools) ? (toolKernel.tools as Array<Record<string, unknown>>) : []
}

function normalizeTests(testsArtifact: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(testsArtifact.tests) ? (testsArtifact.tests as Array<Record<string, unknown>>) : []
}

function normalizeFindings(findingsArtifact: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(findingsArtifact.findings) ? (findingsArtifact.findings as Array<Record<string, unknown>>) : []
}

function normalizeSymbols(symbolArtifact: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(symbolArtifact.symbols) ? (symbolArtifact.symbols as Array<Record<string, unknown>>) : []
}

function normalizeFileIndex(fileArtifact: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(fileArtifact.files) ? (fileArtifact.files as Array<Record<string, unknown>>) : []
}

function normalizeModuleEdges(moduleArtifact: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(moduleArtifact.edges) ? (moduleArtifact.edges as Array<Record<string, unknown>>) : []
}

function buildReviewFindingsFromArtifact(
  reviewFindingsArtifact: Record<string, unknown>,
  findings: CodeFindingRecordV1[],
): Record<string, unknown> {
  return {
    ...reviewFindingsArtifact,
    findings,
  }
}

function buildSemanticPacketData(
  repoRoot: string,
  zipPath: string,
): {
  snapshot: CodeIndexSnapshotV1
  artifacts: PacketArtifactMap
} {
  const manifest = readPacketJson(zipPath, "01_manifest.json")
  const fileIndexArtifact = readPacketJson(zipPath, "02_file_index.json")
  const moduleGraphArtifact = readPacketJson(zipPath, "03_module_graph.json")
  const symbolIndexArtifact = readPacketJson(zipPath, "04_symbol_index.json")
  const typeApiSurfaceArtifact = readPacketJson(zipPath, "05_type_api_surface.json")
  const toolKernelArtifact = readPacketJson(zipPath, "06_tool_kernel_ir.json")
  const pgliteDuckdbArtifact = readPacketJson(zipPath, "07_pglite_duckdb_ir.json")
  const testsArtifact = readPacketJson(zipPath, "08_tests_and_ci_ir.json")
  const architectureArtifact = readPacketJson(zipPath, "09_architecture_context.json")
  const findingsArtifact = readPacketJson(zipPath, "10_review_findings.json")

  const fileIndex = normalizeFileIndex(fileIndexArtifact)
  const fileIndexByPath = new Map<string, CodeFileRecordV1>()
  const mappedFiles = fileIndex.map((file) => {
    const mapped = mapFileRecord(file)
    fileIndexByPath.set(mapped.path, mapped)
    return mapped
  })

  const symbols = normalizeSymbols(symbolIndexArtifact).map((symbol) => mapSymbolRecord(symbol, fileIndexByPath))
  const symbolByName = new Map(symbols.map((symbol) => [symbol.name, symbol] as const))
  const imports = normalizeModuleEdges(moduleGraphArtifact).map((edge, index) => mapImportRecord(edge, fileIndexByPath, index))
  const references = mapReferenceRecords(symbols, imports)
  const tests = normalizeTests(testsArtifact).map((test) => mapTestRecord(test, fileIndexByPath, symbolByName, repoRoot))
  const manifests = buildManifestRecords(repoRoot)
  const findings = normalizeFindings(findingsArtifact).map((finding) => mapFindingRecord(finding))
  const authorityFlows = normalizeToolContracts(toolKernelArtifact).flatMap((tool) => {
    const source = tool.source as Record<string, unknown> | undefined
    const sourcePath = typeof tool.implementation_path === "string" ? tool.implementation_path : String(source?.anchor && typeof (source.anchor as Record<string, unknown>).path === "string" ? (source.anchor as Record<string, unknown>).path : "")
    const criticalFlow = Array.isArray(tool.critical_flow) ? tool.critical_flow as Array<Record<string, unknown>> : []
    return criticalFlow.map((step) => mapAuthorityFlow(String(tool.tool_id ?? "unknown"), step, sourcePath))
  })

  const snapshotId = `snapshot:${String(manifest.git_head_sha ?? "unknown")}:${String(manifest.generated_at ?? new Date().toISOString())}`
  const snapshot: CodeIndexSnapshotV1 = {
    snapshot_id: snapshotId,
    created_at: String(manifest.generated_at ?? new Date().toISOString()),
    repo_root: repoRoot,
    git_sha: typeof manifest.git_head_sha === "string" ? manifest.git_head_sha : undefined,
    git_branch: typeof manifest.git_branch === "string" ? manifest.git_branch : undefined,
    dirty: Boolean(manifest.dirty),
    semantic_packet_path: zipPath,
    source_packet_path: undefined,
    zip_path: zipPath,
    zip_sha256: undefined,
    file_index: mappedFiles,
    module_graph: moduleGraphArtifact,
    symbol_index: symbols,
    type_api_surface: typeApiSurfaceArtifact,
    tool_kernel_ir: toolKernelArtifact,
    pglite_duckdb_ir: pgliteDuckdbArtifact,
    tests_and_ci_ir: testsArtifact,
    architecture_context: architectureArtifact,
    review_findings: buildReviewFindingsFromArtifact(findingsArtifact, findings),
    manifest,
    imports,
    references,
    tests,
    authority_flows: authorityFlows,
    manifests,
    findings,
    events: buildEvents(snapshotId),
    warnings: Array.isArray(manifest.generation_warnings) ? manifest.generation_warnings.map((value) => String(value)) : [],
  }

  return {
    snapshot,
    artifacts: {
      manifest,
      fileIndex: fileIndexArtifact,
      moduleGraph: moduleGraphArtifact,
      symbolIndex: symbolIndexArtifact,
      typeApiSurface: typeApiSurfaceArtifact,
      toolKernelIr: toolKernelArtifact,
      pgliteDuckdbIr: pgliteDuckdbArtifact,
      testsAndCiIr: testsArtifact,
      architectureContext: architectureArtifact,
      reviewFindings: findingsArtifact,
    },
  }
}

async function ensureSemanticPacketZip(
  repoRoot: string,
  force = false,
  options?: { progress?: ReviewExportProgressSinkV1 },
): Promise<{ zipPath: string; zipSha256?: string }> {
  const zipPath = resolve(repoRoot, "tribunus-gemini-ir.zip")
  if (!force && existsSync(zipPath)) {
    return { zipPath }
  }
  const tool = codeReviewExportFactory({ cwd: repoRoot, zod: z })
  const result = await tool.execute(
    "code-intelligence-bootstrap",
    { include_untracked: true, profile: "gemini_structured_ir_v1" },
    (update) => {
      const details = update.details as Record<string, unknown> | undefined
      const stage = typeof details?.stage === "string" ? details.stage : undefined
      const status = typeof details?.status === "string" ? details.status : undefined
      if (!stage || !status) return
      const text = Array.isArray(update.content)
        ? update.content
            .map((item) => (item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : ""))
            .filter(Boolean)
            .join(" ")
        : undefined
      const event: ReviewExportProgressEventV1 = {
        stage: stage as ReviewExportProgressEventV1["stage"],
        status: status as ReviewExportProgressEventV1["status"],
        message: typeof details?.message === "string" ? details.message : text,
      }
      options?.progress?.(event)
    },
    { sessionId: `code-intelligence-${Date.now()}` },
    undefined,
  )
  const details = (result as { details?: Record<string, unknown> }).details
  const outputZip = typeof details?.zipPath === "string" ? details.zipPath : zipPath
  return { zipPath: outputZip, zipSha256: typeof details?.zipSha256 === "string" ? details.zipSha256 : undefined }
}

function packetZipSha256(zipPath: string): string {
  return createHash("sha256").update(readFileSync(zipPath)).digest("hex")
}

export async function ensureCodeIndexSnapshot(
  repoRoot: string,
  force = false,
  options?: { progress?: ReviewExportProgressSinkV1 },
): Promise<CodeIndexSnapshotV1> {
  const store = getCodeIndexStore(repoRoot)
  if (!force) {
    const existing = await store.loadSnapshot()
    if (existing) {
      const currentHead = gitExec(["rev-parse", "HEAD"], repoRoot)
      const currentStatus = gitExec(["status", "--porcelain"], repoRoot)
      const currentSha = currentHead.ok ? currentHead.stdout.trim() : undefined
      const isCurrentlyDirty = currentStatus.ok && currentStatus.stdout.trim().length > 0
      if (existing.git_sha === currentSha && !isCurrentlyDirty && !existing.dirty) {
        return existing
      }
    }
  }

  const { zipPath } = await ensureSemanticPacketZip(repoRoot, force, options)
  const { snapshot } = buildSemanticPacketData(repoRoot, zipPath)
  snapshot.zip_sha256 = packetZipSha256(zipPath)
  await store.saveSnapshot(snapshot)
  return snapshot
}

export async function loadCurrentSnapshot(repoRoot: string): Promise<CodeIndexSnapshotV1 | null> {
  const store = getCodeIndexStore(repoRoot)
  return store.loadSnapshot()
}

export async function refreshSnapshotFiles(repoRoot: string, _paths: string[], _reason: string): Promise<CodeIndexSnapshotV1> {
  return ensureCodeIndexSnapshot(repoRoot, true)
}

export async function exportSemanticPacket(
  repoRoot: string,
  snapshotOverride?: CodeIndexSnapshotV1,
  options?: { force?: boolean; progress?: ReviewExportProgressSinkV1 },
): Promise<{ snapshot: CodeIndexSnapshotV1; zipPath: string; zipSha256: string; warnings: string[]; timings_ms: ReviewExportTimingsV1 }> {
  const started = performance.now()
  const timeline = createReviewExportTimeline(options?.progress)
  const semanticZipDone = timeline.start("semantic_zip", { message: "Loading semantic packet" })
  const snapshot = snapshotOverride ?? await ensureCodeIndexSnapshot(repoRoot, options?.force ?? false, options)
  const zipPath = snapshot.semantic_packet_path ?? resolve(repoRoot, "tribunus-gemini-ir.zip")
  const zipSha256 = snapshot.zip_sha256 ?? packetZipSha256(zipPath)
  const sizeBytes = existsSync(zipPath) ? statSync(zipPath).size : 0
  semanticZipDone({
    semantic_zip: zipPath,
    entries_written: 10,
    bytes_written: sizeBytes,
    message: "Semantic packet ready",
  }, "done")
  return {
    snapshot,
    zipPath,
    zipSha256,
    warnings: snapshot.warnings,
    timings_ms: { semantic_zip: Math.max(0, Math.round(performance.now() - started)) },
  }
}

export async function exportSourcePacket(
  repoRoot: string,
  snapshotOverride?: CodeIndexSnapshotV1,
  options?: { force?: boolean; progress?: ReviewExportProgressSinkV1 },
): Promise<{ snapshot: CodeIndexSnapshotV1; zipPath: string; zipSha256: string; warnings: string[]; timings_ms: ReviewExportTimingsV1 }> {
  const started = performance.now()
  const snapshot = snapshotOverride ?? await ensureCodeIndexSnapshot(repoRoot, options?.force ?? false, options)
  const semanticZip = snapshot.semantic_packet_path ?? resolve(repoRoot, "tribunus-gemini-ir.zip")
  const sourceZip = resolve(repoRoot, "tribunus-source-review.zip")

  const tempDir = resolve(repoRoot, ".omp/state/code-intelligence/source-packet")
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })

  const sourceRoot = resolve(tempDir, "tribunus-source-review")
  mkdirSync(sourceRoot, { recursive: true })

  for (const file of snapshot.file_index) {
    if (file.inclusion_status === "excluded") continue
    const sourcePath = resolve(repoRoot, file.path)
    if (!existsSync(sourcePath)) continue
    const destPath = resolve(sourceRoot, file.path)
    mkdirSync(resolve(destPath, ".."), { recursive: true })
    writeFileSync(destPath, readFileSync(sourcePath))
  }

  const semanticExtractDir = resolve(sourceRoot, "semantic-review")
  mkdirSync(semanticExtractDir, { recursive: true })
  for (const file of [
    "01_manifest.json",
    "02_file_index.json",
    "03_module_graph.json",
    "04_symbol_index.json",
    "05_type_api_surface.json",
    "06_tool_kernel_ir.json",
    "07_pglite_duckdb_ir.json",
    "08_tests_and_ci_ir.json",
    "09_architecture_context.json",
    "10_review_findings.json",
  ]) {
    const bytes = readPacketEntryBytes(semanticZip, file)
    writeFileSync(resolve(semanticExtractDir, file), bytes)
  }

  const archive = createZipCliArchiveBackend()
  const zipResult = archive.zipDirectory({
    source_dir: sourceRoot,
    archive_path: sourceZip,
    stage: "source_zip",
    progress: options?.progress,
  })
  const timings_ms: ReviewExportTimingsV1 = { source_zip: Math.max(0, Math.round(performance.now() - started)) }
  return { snapshot, zipPath: sourceZip, zipSha256: zipResult.sha256, warnings: snapshot.warnings, timings_ms }
}

export async function exportPairedPackets(
  repoRoot: string,
  options?: { progress?: ReviewExportProgressSinkV1 },
): Promise<{
  snapshot: CodeIndexSnapshotV1
  semanticZipPath: string
  semanticZipSha256: string
  sourceZipPath: string
  sourceZipSha256: string
  warnings: string[]
  timings_ms: ReviewExportTimingsV1
}> {
  const pairedStarted = performance.now()
  const timeline = createReviewExportTimeline(options?.progress)

  const discoverDone = timeline.start("discover", { message: "Loading or building code index snapshot" })
  const snapshotStarted = performance.now()
  const snapshot = await ensureCodeIndexSnapshot(repoRoot, true, options)
  timeline.mark("load_or_build_snapshot", performance.now() - snapshotStarted)
  discoverDone({ files_seen: snapshot.file_index.length, message: "Snapshot ready" }, "done")

  const indexDone = timeline.start("index", { message: "Materializing semantic index" })
  indexDone({ files_indexed: snapshot.file_index.length, message: "Index ready" }, "done")

  const semantic = await exportSemanticPacket(repoRoot, snapshot, options)
  const source = await exportSourcePacket(repoRoot, snapshot, options)

  const verifyDone = timeline.start("verify", { message: "Verifying semantic artifacts are byte-identical" })
  const semanticEntries = [
    "01_manifest.json",
    "02_file_index.json",
    "03_module_graph.json",
    "04_symbol_index.json",
    "05_type_api_surface.json",
    "06_tool_kernel_ir.json",
    "07_pglite_duckdb_ir.json",
    "08_tests_and_ci_ir.json",
    "09_architecture_context.json",
    "10_review_findings.json",
  ]
  for (const entry of semanticEntries) {
    const semanticBytes = readPacketEntryBytes(semantic.zipPath, entry)
    const sourceBytes = readZipEntryBytes(source.zipPath, `tribunus-source-review/semantic-review/${entry}`)
    if (Buffer.compare(semanticBytes, sourceBytes) !== 0) {
      throw new Error(`Semantic artifact mismatch for ${entry}`)
    }
  }
  verifyDone({ check: "semantic artifacts byte-identical across packets", message: "Semantic artifacts are byte-identical" }, "done")

  timeline.mark("complete", performance.now() - pairedStarted)
  timeline.emit({
    stage: "complete",
    status: "done",
    semantic_zip: semantic.zipPath,
    source_zip: source.zipPath,
    warnings_count: semantic.warnings.length + source.warnings.length,
    timings_ms: timeline.snapshot(),
    message: "Paired export complete",
  })

  return {
    snapshot,
    semanticZipPath: semantic.zipPath,
    semanticZipSha256: semantic.zipSha256,
    sourceZipPath: source.zipPath,
    sourceZipSha256: source.zipSha256,
    warnings: Array.from(new Set([...semantic.warnings, ...source.warnings])),
    timings_ms: {
      ...timeline.snapshot(),
      ...semantic.timings_ms,
      ...source.timings_ms,
    },
  }
}
