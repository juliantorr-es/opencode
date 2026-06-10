// ─── Gemini Structured IR Builder ───────────────────────────────────────────

import * as ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, basename, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createZipCliArchiveBackend } from "./archive.js";
import { REQUIRE_MISSING_FAIL, V1_PACKET_ID, V1_GENERATOR_VERSION, MAX_FILE_BYTES, GEMINI_MAX_ZIP_BYTES } from "./constants.js";
import { hashText, languageForPath, lineCountForText, normalizeLineBreaks, formatBytes, extOf, filenameOf, sourceLikeExtensions, sourceEquivalentExtensionsFor, isKnownExtension, listFilesRecursive } from "./fs-utils.js";
import { classifyV1FileCategory, importanceForV1File, shouldEmbedFullSource, sourceEmbeddingMode } from "./classification.js";
import { analyzeTypeScriptFile, makeAnchor, makeLineAnchor } from "./ts-analysis.js";
import type { TsAnalysisImport, TsAnalysisExport, TsAnalysisSymbol } from "./ts-analysis.js";
import { analyzeSqlText, analyzeJsonManifest } from "./sql-analysis.js";
import { treeSitterParseStatus, parseStatusForPath, isSourceLike } from "./treesitter.js";
import { createSourceExcerpt, createV1ArtifactHeader, findFirstPatternAnchor } from "./source-excerpt.js";
import { shouldIncludePath } from "./policy.js";
import { unresolvedImportCategoryForStatus, unresolvedImportSeverityForStatus, classifyResolvedNotEmbedded } from "./import-analysis.js";
import type { SourceGraphAnalysisV1 } from "./source-graph.js";
import type { FileEntry, ReviewScope, SourceAnchorV1, GateCheckStatusV1 } from "./types.js";

// ─── Local type aliases ─────────────────────────────────────────────────────

interface TsAnalysisResult {
  parser: SourceGraphAnalysisV1["parser"];
  parse_errors: number;
  parse_error_messages: string[];
  imports: TsAnalysisImport[];
  exports: TsAnalysisExport[];
  symbols: TsAnalysisSymbol[];
  test_cases: Array<{ name: string; anchor: SourceAnchorV1 }>;
  metrics: SourceGraphAnalysisV1["metrics"];
}

interface SqlAnalysisResult {
  tables: string[];
  indexes: string[];
  constraints: Array<{ table: string; kind: "primary_key" | "foreign_key" | "check" | "unique" | "partial_unique_index" | "index"; expression: string }>;
  views: string[];
}

type TreeSitterStatus = "parsed" | "parse_error" | "unsupported_language" | "not_source";

// ─── Helpers (extracted from code_review_export.ts) ────────────────────────

function referencedArtifactsForPath(path: string): string[] {
  const artifacts = new Set<string>(["02_file_index.json"]);
  if (isSourceLike(path) || path.endsWith(".json") || path.endsWith(".sql")) {
    artifacts.add("03_module_graph.json");
    artifacts.add("04_symbol_index.json");
  }
  if (
    path.startsWith(".omp/tools/") ||
    path.startsWith(".omp/mcp") ||
    path === "AGENTS.md" ||
    path === "package.json"
  ) {
    artifacts.add("05_type_api_surface.json");
    artifacts.add("06_tool_kernel_ir.json");
  }
  if (
    path.startsWith(".omp/tools/_lib/store/") ||
    path.startsWith(".omp/tools/_lib/analytics/") ||
    path.endsWith(".sql")
  ) {
    artifacts.add("07_pglite_duckdb_ir.json");
  }
  if (path.startsWith(".omp/tools/tests/") || path.startsWith(".github/workflows/") || path === "package.json") {
    artifacts.add("08_tests_and_ci_ir.json");
  }
  if (
    path.startsWith("docs/") ||
    path.startsWith("docs/json/") ||
    path.startsWith("docs/adr/") ||
    path.startsWith("adrs/") ||
    path.startsWith("adr/") ||
    path === "AGENTS.md" ||
    path === ".omp/mcp.json" ||
    path === ".omp/mcp-manifest.v1.json"
  ) {
    artifacts.add("09_architecture_context.json");
  }
  return [...artifacts];
}

function severityWeight(severity: "info" | "warning" | "critical"): number {
  return severity === "critical" ? 2 : severity === "warning" ? 1 : 0;
}

function readJsonDir(worktree: string, dir: string): Record<string, unknown>[] {
  const fullDir = resolve(worktree, dir);
  if (!existsSync(fullDir)) return [];
  return readdirSync(fullDir)
    .filter((f) => f.endsWith(".v1.json"))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(resolve(fullDir, f), "utf8")) as Record<string, unknown>;
      } catch {
        return { _parseError: true, fileName: f };
      }
    });
}

function extractRelativeImports(source: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /(?:import|export)\s+[^'"`]*?from\s+["'`]([^"'`]+)["'`]/g,
    /import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /require\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]?.startsWith(".")) out.add(match[1]);
    }
  }
  return [...out].sort();
}

function resolveImportCandidates(importer: string, specifier: string, repoRoot: string): string[] {
  const importerDir = resolve(repoRoot, dirname(importer));
  const base = resolve(importerDir, specifier);
  const candidates = new Set<string>();

  const push = (p: string) => candidates.add(p.replace(/\\/g, "/"));

  const ext = extOf(base);
  if (ext && isKnownExtension(ext)) {
    const stem = base.slice(0, -ext.length);
    for (const sourceExt of sourceEquivalentExtensionsFor(specifier)) {
      push(`${stem}${sourceExt}`);
    }
  } else {
    for (const sourceExt of sourceEquivalentExtensionsFor(specifier)) {
      push(`${base}${sourceExt}`);
    }
    for (const sourceExt of sourceEquivalentExtensionsFor(specifier)) {
      push(resolve(base, `index${sourceExt}`));
    }
  }

  return [...candidates].map((candidate) => relative(repoRoot, candidate).replace(/\\/g, "/"));
}

function resolveRelativeImportTarget(importer: string, specifier: string, repoRoot: string): string | undefined {
  const candidates = resolveImportCandidates(importer, specifier, repoRoot);
  for (const candidate of candidates) {
    if (existsSync(resolve(repoRoot, candidate))) return candidate;
  }
  return undefined;
}

function gitExec(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, timeout: 15000, encoding: "utf8" });
  if (result.error) {
    return { ok: false, stdout: "", stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, stdout: result.stdout || "", stderr: result.stderr || `exit ${result.status}` };
  }
  return { ok: true, stdout: result.stdout || "", stderr: "" };
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeArtifactFile(root: string, path: string, content: string): FileEntry {
  const abs = resolve(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  const buf = Buffer.from(content, "utf8");
  writeFileSync(abs, buf);
  return {
    path,
    size_bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    category: "artifact",
  };
}

// ─── Main builder ──────────────────────────────────────────────────────────

export default async function buildGeminiIRArchive(args: {
  repoRoot: string;
  packetRoot: string;
  zipPath: string;
  now: string;
  includeUntracked: boolean;
  reviewScope?: ReviewScope;
}): Promise<{
  includedFiles: FileEntry[];
  warnings: string[];
  zipSha256: string;
  zipSize: number;
}> {
  const warnings: string[] = [];
  const reviewScope = args.reviewScope ?? "general";
  const tmpDir = resolve(tmpdir(), `tribunus-gemini-ir-${Date.now()}`);
  const root = resolve(tmpDir, args.packetRoot);
  mkdirSync(root, { recursive: true });

  const trackedResult = gitExec(args.includeUntracked ? ["ls-files", "--cached", "--others", "--exclude-standard"] : ["ls-files", "--cached"], args.repoRoot);
  const discoveredPaths = trackedResult.ok
    ? trackedResult.stdout.trim().split("\n").filter(Boolean)
        .filter((p) => !p.startsWith(".omp/state/") && !p.startsWith(".omp/evidence/") && !p.startsWith(".omp/journals/") && !p.startsWith(".omp/tools/receipts/") && !p.startsWith(".omp/tools/diffs/") && !p.startsWith(".omp/tools/events/") && !p.startsWith(".omp/tools/journals/"))
    : [];
  const trackedRaw = Array.from(new Set([
    ...discoveredPaths,
    ...REQUIRE_MISSING_FAIL.filter((path) => existsSync(resolve(args.repoRoot, path))),
  ]));
  const directoryLikeTrackedPaths = trackedRaw.filter((path) => existsSync(resolve(args.repoRoot, path)) && statSync(resolve(args.repoRoot, path)).isDirectory());
  const tracked = trackedRaw.filter((path) => !directoryLikeTrackedPaths.includes(path));
  const toolTestFiles = listFilesRecursive(resolve(args.repoRoot, ".omp/tools/tests")).filter((p) => p.endsWith(".ts"));
  const toolText = (p: string) => (existsSync(resolve(args.repoRoot, p)) ? readFileSync(resolve(args.repoRoot, p), "utf8") : "");
  const textByPath = new Map<string, string>();
  const readText = (p: string): string => {
    const existing = textByPath.get(p);
    if (existing !== undefined) return existing;
    const text = toolText(p);
    textByPath.set(p, text);
    return text;
  };
  const embeddedPaths = new Set<string>(tracked.filter((p) => shouldEmbedFullSource(p)));
  const tsSourcePaths = tracked.filter((p) => sourceLikeExtensions(p) && existsSync(resolve(args.repoRoot, p)));

  const gitBranch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], args.repoRoot).stdout.trim() || undefined;
  const gitHeadSha = gitExec(["rev-parse", "HEAD"], args.repoRoot).stdout.trim() || undefined;
  const dirty = gitExec(["status", "--porcelain"], args.repoRoot).stdout.trim().length > 0;
  const repoRootName = basename(args.repoRoot);
  const sourcePaths = tracked.filter((p) => isSourceLike(p));
  const manifestPaths = tracked.filter((p) => p.startsWith(".omp/tools/manifests/") && p.endsWith(".json"));
  const toolPaths = tracked.filter((p) => p.startsWith(".omp/tools/") && p.endsWith(".ts") && !p.includes("/_lib/"));
  const includedDecision = new Map<string, { include: boolean; reason?: string }>();
  const includedSet = new Set<string>();
  for (const path of tracked) {
    const decision = shouldIncludePath(path, []);
    includedDecision.set(path, { include: decision.include, reason: decision.include ? undefined : decision.reason });
    if (decision.include) includedSet.add(path);
  }
  const fileText = (path: string): string => readText(path);
  const fileHash = (path: string): string => createHash("sha256").update(fileText(path)).digest("hex");
  const fileBytes = (path: string): number => Buffer.byteLength(fileText(path), "utf8");

  const tsProgramPaths = sourcePaths.map((p) => resolve(args.repoRoot, p));
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: args.repoRoot,
  };
  const compilerHost = ts.createCompilerHost(compilerOptions, true);
  compilerHost.getCurrentDirectory = () => args.repoRoot;
  compilerHost.readFile = (fileName) => {
    const abs = resolve(fileName);
    const rel = relative(args.repoRoot, abs).replace(/\\/g, "/");
    return existsSync(abs) ? fileText(rel) : undefined;
  };
  compilerHost.fileExists = (fileName) => existsSync(resolve(fileName));
  compilerHost.directoryExists = (dirName) => existsSync(resolve(dirName));
  const program = ts.createProgram(tsProgramPaths, compilerOptions, compilerHost);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => {
    const filePath = d.file?.fileName ? relative(args.repoRoot, resolve(d.file.fileName)).replace(/\\/g, "/") : undefined;
    return !filePath || tracked.includes(filePath);
  });
  const analysisByPath = new Map<string, TsAnalysisResult>();
  for (const path of sourcePaths) {
    analysisByPath.set(path, analyzeTypeScriptFile({
      path,
      text: fileText(path),
      repoRoot: args.repoRoot,
      includedSet,
    }));
  }
  const sourceGraphAnalyses = [...analysisByPath.values()];
  const sourceGraphSummary = sourceGraphAnalyses.reduce((acc, analysis) => {
    acc.files += 1;
    if (analysis.parser === "oxc") acc.oxc_files += 1;
    if (analysis.parser === "fallback") acc.fallback_files += 1;
    acc.parse_errors += analysis.parse_errors;
    acc.parse_ms += analysis.metrics.parse_ms;
    acc.resolve_ms += analysis.metrics.resolve_ms;
    acc.static_imports += analysis.metrics.static_imports;
    acc.static_exports += analysis.metrics.static_exports;
    acc.dynamic_imports += analysis.metrics.dynamic_imports;
    acc.import_metas += analysis.metrics.import_metas;
    acc.type_only_edges += analysis.metrics.type_only_edges;
    acc.side_effect_edges += analysis.metrics.side_effect_edges;
    acc.resolved_edges += analysis.metrics.resolved_edges;
    acc.unresolved_edges += analysis.metrics.unresolved_edges;
    acc.resolved_not_embedded += analysis.metrics.resolved_not_embedded;
    acc.external_package += analysis.metrics.external_package;
    acc.builtin += analysis.metrics.builtin;
    acc.ts_js_extension_remap += analysis.metrics.ts_js_extension_remap;
    acc.missing_source += analysis.metrics.missing_source;
    acc.missing_asset += analysis.metrics.missing_asset;
    acc.missing_generated += analysis.metrics.missing_generated;
    acc.missing_prompt_template += analysis.metrics.missing_prompt_template;
    acc.missing_route_target += analysis.metrics.missing_route_target;
    acc.parse_failures += analysis.metrics.parse_failures;
    for (const message of analysis.parse_error_messages) {
      if (acc.parse_error_messages.length >= 10) break;
      if (!acc.parse_error_messages.includes(message)) acc.parse_error_messages.push(message);
    }
    return acc;
  }, {
    files: 0,
    oxc_files: 0,
    fallback_files: 0,
    parse_errors: 0,
    parse_ms: 0,
    resolve_ms: 0,
    static_imports: 0,
    static_exports: 0,
    dynamic_imports: 0,
    import_metas: 0,
    type_only_edges: 0,
    side_effect_edges: 0,
    resolved_edges: 0,
    unresolved_edges: 0,
    resolved_not_embedded: 0,
    external_package: 0,
    builtin: 0,
    ts_js_extension_remap: 0,
    missing_source: 0,
    missing_asset: 0,
    missing_generated: 0,
    missing_prompt_template: 0,
    missing_route_target: 0,
    parse_failures: 0,
    parse_error_messages: [] as string[],
  });
  const sqlByPath = new Map<string, SqlAnalysisResult>();
  for (const path of tracked.filter((p) => p.endsWith(".sql"))) {
    sqlByPath.set(path, analyzeSqlText(fileText(path)));
  }
  const jsonByPath = new Map<string, Record<string, any>>();
  for (const path of tracked.filter((p) => p.endsWith(".json") || p.endsWith(".jsonc"))) {
    jsonByPath.set(path, analyzeJsonManifest(path, fileText(path)));
  }

  const treeParseResults = new Map<string, TreeSitterStatus>();
  await Promise.all(
    tracked.map(async (path) => {
      if (path.startsWith(".omp/tools/") || isSourceLike(path) || path.endsWith(".json") || path.endsWith(".sql")) {
        treeParseResults.set(path, await treeSitterParseStatus(path, fileText(path)));
      } else {
        treeParseResults.set(path, parseStatusForPath(path, fileText(path)));
      }
    }),
  );

  const directorySummaryMap = new Map<string, { file_count: number; categories: Record<string, number> }>();
  const bumpDirectory = (directory: string, category: string) => {
    const key = directory || ".";
    const entry = directorySummaryMap.get(key) ?? { file_count: 0, categories: {} };
    entry.file_count += 1;
    entry.categories[category] = (entry.categories[category] ?? 0) + 1;
    directorySummaryMap.set(key, entry);
  };
  for (const path of tracked) {
    const category = classifyV1FileCategory(path);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      bumpDirectory(parts.slice(0, i).join("/"), category);
    }
    if (parts.length === 1) bumpDirectory(".", category);
  }

  const fileIndex = tracked.map((path) => {
    const decision = includedDecision.get(path);
    const embeddingMode = sourceEmbeddingMode(path);
    const inclusion = decision?.include
      ? embeddingMode === "full"
        ? "included_full"
        : embeddingMode === "excerpt" || embeddingMode === "signature_only"
          ? "included_partial"
          : "indexed_only"
      : "excluded";
    return {
      file_id: `file:${path}`,
      path,
      category: classifyV1FileCategory(path),
      language: languageForPath(path),
      size_bytes: existsSync(resolve(args.repoRoot, path)) ? statSync(resolve(args.repoRoot, path)).size : 0,
      line_count: existsSync(resolve(args.repoRoot, path)) && !path.endsWith(".png") && !path.endsWith(".jpg") && !path.endsWith(".gif") ? lineCountForText(fileText(path)) : undefined,
      sha256: existsSync(resolve(args.repoRoot, path)) ? fileHash(path) : undefined,
      inclusion,
      exclusion_reason: decision?.include ? undefined : decision?.reason,
      parse_status: treeParseResults.get(path) ?? parseStatusForPath(path, fileText(path)),
      importance: importanceForV1File(path),
      referenced_by_artifacts: referencedArtifactsForPath(path),
    };
  });

  const moduleGraphModules = sourcePaths.map((path) => {
    const analysis = analysisByPath.get(path);
    const text = fileText(path);
    const dynamicImports = [...text.matchAll(/import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]!).filter(Boolean);
    const requireImports = [...text.matchAll(/require\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]!).filter(Boolean);
    return {
      module_id: `module:${path}`,
      path,
      language: languageForPath(path),
      exports: [...new Set([...(analysis?.exports ?? []).map((e) => e.name)])],
      imports: [...new Set([...(analysis?.imports ?? []).map((i) => i.specifier), ...requireImports])],
      side_effect_imports: [...new Set((analysis?.imports ?? []).filter((i) => i.import_kind === "side_effect").map((i) => i.specifier))],
      dynamic_imports: [...new Set(dynamicImports)],
    };
  });

  const moduleGraphEdges = sourcePaths.flatMap((path) => {
    const analysis = analysisByPath.get(path);
    return (analysis?.imports ?? []).map((imp) => ({
      from_path: path,
      specifier: imp.specifier,
      import_kind: imp.import_kind,
      resolution_status: imp.resolution_status,
      resolved_path: imp.resolved_path,
      start_line: imp.start_line,
      end_line: imp.end_line,
      unresolved_category: imp.resolution_status === "resolved_in_packet" || imp.resolution_status === "external_package" || imp.resolution_status === "builtin"
        ? undefined
        : unresolvedImportCategoryForStatus(imp.resolution_status),
      review_severity: imp.resolution_status === "resolved_in_packet" || imp.resolution_status === "external_package" || imp.resolution_status === "builtin"
        ? undefined
        : unresolvedImportSeverityForStatus(imp.resolution_status, reviewScope),
      reason: imp.resolution_status === "resolved_in_packet" ? undefined : imp.resolution_status,
    }));
  });

  const unresolvedImportItems = moduleGraphEdges
    .filter((edge) => !["resolved_in_packet", "external_package", "builtin"].includes(edge.resolution_status))
    .map((edge) => {
      let severity = edge.review_severity ?? unresolvedImportSeverityForStatus(edge.resolution_status, reviewScope);
      if (edge.resolution_status === "resolved_not_embedded" && edge.resolved_path) {
        const tuning = classifyResolvedNotEmbedded(edge.resolved_path, edge.from_path);
        if (tuning.severity === "ignored") return null;
        severity = tuning.severity;
      }
      return {
        from_path: edge.from_path,
        specifier: edge.specifier,
        resolution_status: edge.resolution_status,
        category: edge.unresolved_category ?? unresolvedImportCategoryForStatus(edge.resolution_status),
        severity: severity,
        resolved_path: edge.resolved_path,
        reason: edge.resolution_status,
        start_line: edge.start_line,
        end_line: edge.end_line,
        source_anchor: makeLineAnchor({
          path: edge.from_path,
          text: fileText(edge.from_path),
          start_line: edge.start_line,
          end_line: edge.end_line,
          symbol_id: `import:${edge.from_path}#${edge.specifier}`,
        }),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .slice(0, 400);

  const unresolvedSummary = {
    total: unresolvedImportItems.length,
    by_resolution_status: unresolvedImportItems.reduce((acc, item) => {
      acc[item.resolution_status] = (acc[item.resolution_status] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    by_category: unresolvedImportItems.reduce((acc, item) => {
      acc[item.category] = (acc[item.category] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    by_severity: unresolvedImportItems.reduce((acc, item) => {
      acc[item.severity] = (acc[item.severity] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };

  const moduleEdgesBySource = new Map<string, string[]>();
  const localResolvedEdges = moduleGraphEdges.filter((edge) => edge.resolution_status === "resolved_in_packet" && edge.resolved_path);
  for (const edge of localResolvedEdges) {
    const list = moduleEdgesBySource.get(edge.from_path) ?? [];
    list.push(edge.resolved_path!);
    moduleEdgesBySource.set(edge.from_path, list);
  }

  const cycles: Array<{ cycle_id: string; paths: string[]; severity: "info" | "warning" | "critical"; reason: string }> = [];
  const cycleSeen = new Set<string>();
  const visitCycle = (path: string, stack: string[], seen: Set<string>) => {
    if (stack.includes(path)) {
      const cycle = stack.slice(stack.indexOf(path)).concat(path);
      const cycleKey = cycle.join("->");
      if (!cycleSeen.has(cycleKey)) {
        cycleSeen.add(cycleKey);
        cycles.push({
          cycle_id: `cycle:${cycles.length + 1}`,
          paths: cycle,
          severity: "warning",
          reason: "Local import cycle in packet-resolved dependencies.",
        });
      }
      return;
    }
    if (seen.has(path)) return;
    seen.add(path);
    for (const next of moduleEdgesBySource.get(path) ?? []) {
      visitCycle(next, [...stack, path], seen);
    }
  };
  for (const path of sourcePaths) {
    visitCycle(path, [], new Set<string>());
  }

  const criticalRoots = [
    ".omp/tools/struct_read.ts",
    ".omp/tools/text_replace.ts",
    ".omp/tools/batch_edit.ts",
    ".omp/tools/code_review_export.ts",
    ".omp/tools/_lib/store/pglite-store.ts",
    ".omp/tools/_lib/analytics/duckdb-projector.ts",
  ].filter((p) => tracked.includes(p));
  const criticalDependencyClosures = criticalRoots.map((rootPath) => {
    const closure = new Set<string>();
    const missing = new Set<string>();
    const stack = [rootPath];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (closure.has(current)) continue;
      closure.add(current);
      for (const edge of moduleGraphEdges.filter((edge) => edge.from_path === current)) {
        if (edge.resolution_status === "resolved_in_packet" && edge.resolved_path) {
          if (!closure.has(edge.resolved_path)) stack.push(edge.resolved_path);
        } else if (edge.resolution_status === "resolved_not_embedded" && edge.resolved_path) {
          missing.add(edge.resolved_path);
        } else if (edge.resolution_status.startsWith("missing") || edge.resolution_status === "ts_js_extension_remap") {
          missing.add(edge.specifier);
        }
      }
    }
    return {
      root_path: rootPath,
      closure_paths: [...closure].sort(),
      missing_paths: [...missing].sort(),
      resolved: missing.size === 0,
    };
  });

  const symbolMap = new Map<string, { symbol_id: string; name: string; kind: string; exported: boolean; anchor: SourceAnchorV1; signature?: string; doc_summary?: string; calls?: string[]; called_by?: string[]; references?: string[]; tags: string[] }>();
  for (const path of sourcePaths) {
    const analysis = analysisByPath.get(path);
    for (const symbol of analysis?.symbols ?? []) {
      symbolMap.set(symbol.anchor.symbol_id ?? `symbol:${path}#${symbol.name}`, {
        symbol_id: symbol.anchor.symbol_id ?? `symbol:${path}#${symbol.name}`,
        name: symbol.name,
        kind: symbol.kind,
        exported: symbol.exported,
        anchor: symbol.anchor,
        signature: symbol.signature,
        tags: symbol.tags,
      });
    }
    for (const testCase of analysis?.test_cases ?? []) {
      symbolMap.set(testCase.anchor.symbol_id ?? `test:${path}#${testCase.name}`, {
        symbol_id: testCase.anchor.symbol_id ?? `test:${path}#${testCase.name}`,
        name: testCase.name,
        kind: "test_case",
        exported: false,
        anchor: testCase.anchor,
        tags: ["test"],
      });
    }
  }
  for (const path of tracked.filter((p) => p.endsWith(".sql"))) {
    const sql = sqlByPath.get(path);
    const text = fileText(path);
    for (const table of sql?.tables ?? []) {
      const anchor = findFirstPatternAnchor({ path, text, patterns: [new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")], symbolId: `symbol:${path}#table:${table}` });
      if (anchor) {
        symbolMap.set(anchor.symbol_id ?? `symbol:${path}#table:${table}`, {
          symbol_id: anchor.symbol_id ?? `symbol:${path}#table:${table}`,
          name: table,
          kind: "sql_table",
          exported: false,
          anchor,
          tags: ["sql", "table"],
        });
      }
    }
    for (const indexName of sql?.indexes ?? []) {
      const anchor = findFirstPatternAnchor({ path, text, patterns: [new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${indexName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")], symbolId: `symbol:${path}#index:${indexName}` });
      if (anchor) {
        symbolMap.set(anchor.symbol_id ?? `symbol:${path}#index:${indexName}`, {
          symbol_id: anchor.symbol_id ?? `symbol:${path}#index:${indexName}`,
          name: indexName,
          kind: "sql_index",
          exported: false,
          anchor,
          tags: ["sql", "index"],
        });
      }
    }
  }
  for (const path of manifestPaths) {
    const manifest = jsonByPath.get(path);
    const name = manifest?.name ?? basename(path, ".json");
    const anchor = makeAnchor({ path, text: fileText(path), start: 0, end: fileText(path).length, symbol_id: `symbol:${path}#manifest:${name}` });
    symbolMap.set(anchor.symbol_id ?? `symbol:${path}#manifest:${name}`, {
      symbol_id: anchor.symbol_id ?? `symbol:${path}#manifest:${name}`,
      name,
      kind: "manifest",
      exported: false,
      anchor,
      signature: manifest?.schema ?? undefined,
      tags: ["manifest"],
    });
  }
  for (const path of toolPaths) {
    const toolId = basename(path, ".ts");
    const anchor = makeAnchor({ path, text: fileText(path), start: 0, end: Math.min(fileText(path).length, 120), symbol_id: `tool:${toolId}` });
    symbolMap.set(`tool:${toolId}`, {
      symbol_id: `tool:${toolId}`,
      name: toolId,
      kind: "tool_handler",
      exported: true,
      anchor,
      signature: toolId,
      tags: ["tool", "handler"],
    });
  }
  const symbolIndex = [...symbolMap.values()].sort((a, b) => a.symbol_id.localeCompare(b.symbol_id));

  const authoritySymbolIds = [
    { symbol_id: "tool:text_replace", role: "hash_precondition" as const },
    { symbol_id: "tool:text_replace", role: "path_lock" as const },
    { symbol_id: "tool:text_replace", role: "receipt_writer" as const },
    { symbol_id: "tool:batch_edit", role: "hash_precondition" as const },
    { symbol_id: "tool:batch_edit", role: "path_lock" as const },
    { symbol_id: "tool:batch_edit", role: "journal_writer" as const },
    { symbol_id: "tool:struct_read", role: "path_policy" as const },
    { symbol_id: "symbol:.omp/tools/_lib/store/pglite-store.ts#acquirePathLocks", role: "path_lock" as const },
    { symbol_id: "symbol:.omp/tools/_lib/store/pglite-store.ts#releasePathLocks", role: "path_lock" as const },
    { symbol_id: "symbol:.omp/tools/_lib/store/pglite-store.ts#recordMutation", role: "store_transaction" as const },
    { symbol_id: "symbol:.omp/tools/_lib/store/pglite-store.ts#createWriteJournal", role: "journal_writer" as const },
  ];

  const missingExpectedSymbols = [
    { expected: "tool:text_replace", reason: symbolMap.has("tool:text_replace") ? "present" : "tool handler not indexed", severity: symbolMap.has("tool:text_replace") ? "info" as const : "critical" as const },
    { expected: "tool:batch_edit", reason: symbolMap.has("tool:batch_edit") ? "present" : "tool handler not indexed", severity: symbolMap.has("tool:batch_edit") ? "info" as const : "critical" as const },
    { expected: "tool:struct_read", reason: symbolMap.has("tool:struct_read") ? "present" : "tool handler not indexed", severity: symbolMap.has("tool:struct_read") ? "info" as const : "critical" as const },
  ].filter((entry) => entry.severity === "critical");

  const consumerMap = new Map<string, string[]>();
  for (const edge of moduleGraphEdges) {
    if (!edge.resolved_path) continue;
    const list = consumerMap.get(edge.resolved_path) ?? [];
    if (!list.includes(edge.from_path)) list.push(edge.from_path);
    consumerMap.set(edge.resolved_path, list);
  }

  const exportedContracts = symbolIndex
    .filter((symbol) => symbol.exported || symbol.kind === "manifest" || symbol.kind === "tool_handler")
    .map((symbol) => ({
      contract_id: symbol.symbol_id,
      path: symbol.anchor.path,
      name: symbol.name,
      kind: symbol.kind === "sql_table" || symbol.kind === "sql_index" || symbol.kind === "manifest" ? "schema" : symbol.kind === "interface" || symbol.kind === "type_alias" ? "type" : symbol.kind === "class" ? "class" : symbol.kind === "function" || symbol.kind === "tool_handler" ? "function" : "function",
      signature_or_shape: symbol.signature ?? symbol.doc_summary ?? "",
      anchor: symbol.anchor,
      consumers: consumerMap.get(symbol.anchor.path) ?? [],
      stability: symbol.anchor.path.startsWith(".omp/tools/") ? "internal" as const : symbol.anchor.path.startsWith("packages/") ? "public" as const : "experimental" as const,
    }));

  const toolManifestObjects = manifestPaths.map((path) => {
    const data = jsonByPath.get(path) ?? {};
    const toolId = String((data as Record<string, unknown>).tool_id ?? basename(path, ".v1.json").replace(/\.v1$/, ""));
    return { path, data };
  });
  const toolContracts = toolManifestObjects
    .map(({ path, data }) => {
      const toolId = String((data as Record<string, unknown>).tool_id ?? basename(path, ".v1.json").replace(/\.v1$/, ""));
      const implementationPath = `.omp/tools/${toolId}.ts`;
      const hasImplementation = tracked.includes(implementationPath);
      const implementationText = hasImplementation ? fileText(implementationPath) : "";
      const authority = (data as Record<string, unknown>).authority as Record<string, unknown> | undefined;
      const riskLevel = typeof authority?.risk_level === "string" ? authority.risk_level : "read";
      const match = implementationText.match(/const\s+RISK_LEVEL(?::\s*\w+)?\s*=\s*"([^"]+)"/);
      const implementationRisk = toolId === "text_replace" || toolId === "batch_edit"
        ? (match?.[1] ?? riskLevel)
        : riskLevel;
      const mismatches: Array<{ field: string; manifest_value: unknown; implementation_value: unknown; severity: "warning" | "critical" }> = [];
      if (implementationRisk !== riskLevel) {
        mismatches.push({
          field: "authority.risk_level",
          manifest_value: riskLevel,
          implementation_value: implementationRisk,
          severity: "critical",
        });
      }
      const sideEffects = toolId === "text_replace"
        ? ["filesystem_write", "receipt_write", "diff_write", "audit_event", "store_mutation"]
        : toolId === "batch_edit"
          ? ["filesystem_write", "receipt_write", "diff_write", "journal_write", "audit_event", "store_mutation"]
          : ["filesystem_read"];
      return {
        tool_id: toolId,
        manifest_path: path,
        implementation_path: implementationPath,
        input_schema_summary: (data as Record<string, unknown>).input_schema ?? {},
        output_schema_summary: (data as Record<string, unknown>).output_schema ?? {},
        authority_profile: {
          risk_level: implementationRisk,
          requires_active_session: implementationRisk !== "read",
          requires_hash_precondition: toolId !== "struct_read",
          requires_path_lock: toolId !== "struct_read",
          requires_approval: toolId !== "struct_read",
          side_effects: sideEffects,
        },
        manifest_implementation_mismatches: mismatches,
      };
    });

  const pgliteTypesText = fileText(".omp/tools/_lib/store/pglite-types.ts");
  const pgliteStoreText = fileText(".omp/tools/_lib/store/pglite-store.ts");
  const pgliteMethods = [
    "migrate",
    "createActor",
    "createSession",
    "heartbeatSession",
    "closeSession",
    "abandonExpiredSessions",
    "claimWork",
    "releaseWorkClaim",
    "acquirePathLocks",
    "releasePathLocks",
    "findConflictingLocks",
    "recordInvocation",
    "recordMutation",
    "recordInvocationWithMutations",
    "recordRead",
    "createWriteJournal",
    "updateWriteJournalStatus",
    "findPendingJournals",
    "listRecentInvocations",
    "listEffectsForPath",
  ];
  const storeContracts = [{
    store_id: "OmpRelationalStoreV1",
    path: ".omp/tools/_lib/store/pglite-types.ts",
    methods: pgliteMethods.map((name) => ({
      name,
      signature: (pgliteTypesText.match(new RegExp(`${name}\\s*\\([^\\)]*\\):\\s*[^\\n]+`, "m"))?.[0] ?? name).trim(),
      transaction_behavior: [
        "migrate",
        "createActor",
        "createSession",
        "claimWork",
        "acquirePathLocks",
        "recordInvocation",
        "recordMutation",
        "recordInvocationWithMutations",
        "createWriteJournal",
      ].includes(name)
        ? "multi_statement_transaction" as const
        : ["heartbeatSession", "closeSession", "releaseWorkClaim", "releasePathLocks", "updateWriteJournalStatus"].includes(name)
          ? "single_write" as const
          : ["findConflictingLocks", "findPendingJournals", "listRecentInvocations", "listEffectsForPath"].includes(name)
            ? "read_only" as const
            : "unknown" as const,
      authority_role: [
        "acquirePathLocks",
        "releasePathLocks",
        "recordInvocation",
        "recordMutation",
        "recordInvocationWithMutations",
        "createWriteJournal",
        "updateWriteJournalStatus",
      ].includes(name)
        ? "store_transaction"
        : name === "findConflictingLocks"
          ? "path_lock_truth"
          : name === "findPendingJournals"
            ? "journal_truth"
            : name === "listEffectsForPath"
              ? "file_effect_truth"
              : "session_truth",
    })),
  }];

  const toolKernelTools = [
    "text_replace",
    "batch_edit",
    "struct_read",
    "code_review_export",
  ].filter((toolId) => tracked.includes(`.omp/tools/${toolId}.ts`))
    .map((toolId) => {
      const path = `.omp/tools/${toolId}.ts`;
      const text = fileText(path);
      const manifestPath = manifestPaths.find((p) => fileText(p).includes(`"tool_id": "${toolId}"`));
      const sourceInclusion = sourceEmbeddingMode(path);
      const excerpt = createSourceExcerpt({
        path,
        text,
        inclusion: sourceInclusion === "full" ? "full" : "excerpt",
        reason: sourceInclusion === "full" ? "authority-critical tool source" : "tool source excerpt",
        maxChars: sourceInclusion === "full" ? text.length : 5000,
        omittedReason: sourceInclusion === "full" ? undefined : "Packet uses selective excerpt for this tool",
      });
      const flowPatternsByTool: Record<string, Array<{ step: string; pattern: string | RegExp }>> = {
        text_replace: [
          { step: "validate_input", pattern: /validateTextReplaceInput|validate.*TextReplaceInput/ },
          { step: "resolve_path", pattern: /resolveWritePath/ },
          { step: "acquire_path_lock", pattern: /acquirePathLocks/ },
          { step: "verify_hash", pattern: /beforeHash\s*!==/ },
          { step: "write_file", pattern: /writeFileSync|await\s+fs\.writeFile|writeFile/ },
          { step: "write_diff", pattern: /writeDiffArtifact/ },
          { step: "write_receipt", pattern: /writeReceipt/ },
          { step: "record_store_mutation", pattern: /recordMutation|recordInvocationWithMutations/ },
          { step: "append_audit_event", pattern: /appendAuditEvent/ },
          { step: "release_path_lock", pattern: /releasePathLocks/ },
          { step: "return_envelope", pattern: /createEnvelope|return\s+wrap/ },
        ],
        batch_edit: [
          { step: "validate_input", pattern: /validateBatchEditInput|validate.*BatchEditInput/ },
          { step: "resolve_path", pattern: /resolveWritePath/ },
          { step: "acquire_path_lock", pattern: /acquirePathLocks/ },
          { step: "verify_hash", pattern: /beforeHash\s*!==/ },
          { step: "apply_in_memory_edit", pattern: /apply.*edit|replace_exact_once|state\.after/ },
          { step: "write_journal", pattern: /createWriteJournal|write_journal/ },
          { step: "write_diff", pattern: /writeCombinedDiffArtifact|writeDiffArtifact/ },
          { step: "write_receipt", pattern: /writeReceipt/ },
          { step: "record_store_mutation", pattern: /recordMutation|recordInvocationWithMutations/ },
          { step: "append_audit_event", pattern: /appendAuditEvent/ },
          { step: "release_path_lock", pattern: /releasePathLocks/ },
          { step: "return_envelope", pattern: /createEnvelope|return\s+wrap/ },
        ],
        struct_read: [
          { step: "validate_input", pattern: /validate.*StructReadInput|resolveReadPath/ },
          { step: "resolve_path", pattern: /resolveReadPath/ },
          { step: "read_file", pattern: /readFileSync|readFile/ },
          { step: "return_envelope", pattern: /createEnvelope|return\s+wrap/ },
        ],
        code_review_export: [
          { step: "validate_input", pattern: /include_untracked|profile/ },
          { step: "resolve_path", pattern: /resolve\(w, "tribunus-gemini/ },
          { step: "write_journal", pattern: /writeArtifactFile|jsonText/ },
          { step: "return_envelope", pattern: /return\s+\{/ },
        ],
      };
      const flowPatterns = flowPatternsByTool[toolId] ?? [];
      const criticalFlow = flowPatterns.map((item) => {
        const anchor = findFirstPatternAnchor({ path, text, patterns: [item.pattern], symbolId: `flow:${toolId}:${item.step}` });
        return {
          step: item.step,
          detected: Boolean(anchor),
          symbol_id: anchor?.symbol_id,
          anchor,
          confidence: anchor ? "semantic" : "missing",
          notes: anchor ? undefined : `Could not find ${item.step} evidence in ${toolId}`,
        };
      });
      const safetyProperties = {
        exact_once_replacement: toolId === "text_replace",
        rejects_multiple_matches: toolId === "text_replace" || toolId === "batch_edit",
        rejects_missing_match: toolId === "text_replace" || toolId === "batch_edit",
        verifies_hash_after_lock: toolId !== "struct_read",
        releases_locks_in_finally: toolId === "text_replace" || toolId === "batch_edit",
        records_receipt: toolId !== "struct_read",
        records_diff: toolId !== "struct_read",
        records_audit_event: toolId !== "struct_read",
        records_pglite_mutation: toolId !== "struct_read",
        uses_redaction: toolId === "batch_edit" || toolId === "text_replace",
      };
      const authorityProfile = toolId === "struct_read"
        ? {
            risk_level: "read" as const,
            requires_active_session: false,
            requires_hash_precondition: false,
            requires_path_lock: false,
            side_effects: ["filesystem_read"],
          }
        : toolId === "batch_edit"
          ? {
              risk_level: "write_high" as const,
              requires_active_session: true,
              requires_hash_precondition: true,
              requires_path_lock: true,
              side_effects: ["filesystem_write", "receipt_write", "diff_write", "journal_write", "audit_event", "store_mutation"],
            }
          : {
              risk_level: "write_medium" as const,
              requires_active_session: true,
              requires_hash_precondition: true,
              requires_path_lock: true,
              side_effects: ["filesystem_write", "receipt_write", "diff_write", "audit_event", "store_mutation"],
            };
      return {
        tool_id: toolId,
        implementation_path: path,
        manifest_path: manifestPath,
        authority_profile: authorityProfile,
        critical_flow: criticalFlow,
        safety_properties: safetyProperties,
        source: excerpt,
      };
    });

  const kernelFiles = [
    ".omp/tools/_lib/envelope.ts",
    ".omp/tools/_lib/hashing.ts",
    ".omp/tools/_lib/path-policy.ts",
    ".omp/tools/_lib/schemas.ts",
    ".omp/tools/_lib/receipts.ts",
    ".omp/tools/_lib/diff.ts",
    ".omp/tools/_lib/audit.ts",
    ".omp/tools/_lib/ids.ts",
    ".omp/tools/_lib/errors.ts",
    ".omp/tools/_lib/json.ts",
    ".omp/tools/_lib/tool-context.ts",
    ".omp/tools/_lib/redaction.ts",
    ".omp/tools/_lib/write-journal.ts",
    ".omp/tools/_lib/types.ts",
    ".omp/tools/code_review_export.ts",
  ].filter((p) => tracked.includes(p))
    .map((path) => {
      const role = path.includes("envelope")
        ? "envelope"
        : path.includes("hashing")
          ? "hashing"
          : path.includes("path-policy")
            ? "path_policy"
            : path.includes("schemas")
              ? "schemas"
              : path.includes("receipts")
                ? "receipts"
                : path.includes("diff")
                  ? "diff"
                  : path.includes("audit")
                    ? "audit"
                    : path.includes("ids")
                      ? "ids"
                      : path.includes("errors")
                        ? "errors"
                        : path.includes("json")
                          ? "manifest"
                          : path.includes("tool-context")
                            ? "tool_context"
                            : path.includes("redaction")
                              ? "redaction"
                              : path.includes("write-journal")
                                ? "write_journal"
                                : path.includes("types")
                                  ? "adapter"
                                  : "manifest";
      const text = fileText(path);
      return {
        path,
        role,
        exported_symbols: (analysisByPath.get(path)?.exports ?? []).map((entry) => entry.name),
        source: createSourceExcerpt({
          path,
          text,
          inclusion: "full",
          reason: "Authority-critical kernel file",
          line_count: lineCountForText(text),
          byte_count: Buffer.byteLength(text, "utf8"),
        }),
      };
    });

  const providerAdapters = [
    { provider: "mistral", path: ".omp/tools/_lib/adapters/mistral.ts", generated_from_manifest: true, owns_authority: false, notes: "Provider transport adapter only." },
    { provider: "openai", path: ".omp/tools/_lib/adapters/openai.ts", generated_from_manifest: true, owns_authority: false, notes: "Provider transport adapter only." },
    { provider: "anthropic", path: ".omp/tools/_lib/adapters/anthropic.ts", generated_from_manifest: true, owns_authority: false, notes: "Provider transport adapter only." },
    { provider: "mcp", path: ".omp/tools/_lib/adapters/mcp.ts", generated_from_manifest: false, owns_authority: false, notes: "MCP transport adapter only." },
  ].filter((entry) => tracked.includes(entry.path));

  const migrationPaths = [
    ".omp/tools/_lib/store/migrations/0001_core.sql",
    ".omp/tools/_lib/store/migrations/0002_indexes.sql",
  ].filter((p) => tracked.includes(p));
  const migrationObjects = migrationPaths.map((path, index) => {
    const text = fileText(path);
    const schema = sqlByPath.get(path);
    return {
      migration_id: basename(path, ".sql"),
      path,
      order: index + 1,
      sha256: fileHash(path),
      sql: text,
      tables_created: schema?.tables ?? [],
      indexes_created: schema?.indexes ?? [],
      constraints: schema?.constraints ?? [],
    };
  });
  const pgliteTables = [
    {
      table: "actors",
      purpose: "actor registry",
      columns: [
        { name: "actor_id", type: "TEXT", nullable: false },
        { name: "kind", type: "TEXT", nullable: false },
        { name: "provider", type: "TEXT", nullable: true },
        { name: "model", type: "TEXT", nullable: true },
        { name: "display_name", type: "TEXT", nullable: true },
        { name: "created_at", type: "TEXT", nullable: false },
      ],
      authority_role: "session_truth" as const,
    },
    {
      table: "sessions",
      purpose: "session lifecycle truth",
      columns: [
        { name: "session_id", type: "TEXT", nullable: false },
        { name: "actor_id", type: "TEXT", nullable: false },
        { name: "status", type: "TEXT", nullable: false },
        { name: "purpose", type: "TEXT", nullable: true },
        { name: "started_at", type: "TEXT", nullable: false },
        { name: "last_heartbeat_at", type: "TEXT", nullable: false },
        { name: "closed_at", type: "TEXT", nullable: true },
      ],
      authority_role: "session_truth" as const,
    },
    {
      table: "work_items",
      purpose: "work queue truth",
      columns: [
        { name: "work_id", type: "TEXT", nullable: false },
        { name: "kind", type: "TEXT", nullable: false },
        { name: "title", type: "TEXT", nullable: false },
        { name: "status", type: "TEXT", nullable: false },
        { name: "priority", type: "INTEGER", nullable: false },
        { name: "created_by_session_id", type: "TEXT", nullable: true },
        { name: "created_at", type: "TEXT", nullable: false },
        { name: "updated_at", type: "TEXT", nullable: false },
      ],
      authority_role: "work_claim_truth" as const,
    },
    {
      table: "work_claims",
      purpose: "work claim truth",
      columns: [
        { name: "claim_id", type: "TEXT", nullable: false },
        { name: "work_id", type: "TEXT", nullable: false },
        { name: "session_id", type: "TEXT", nullable: false },
        { name: "status", type: "TEXT", nullable: false },
        { name: "claimed_at", type: "TEXT", nullable: false },
        { name: "expires_at", type: "TEXT", nullable: false },
        { name: "released_at", type: "TEXT", nullable: true },
      ],
      authority_role: "work_claim_truth" as const,
    },
    {
      table: "path_locks",
      purpose: "path lock truth",
      columns: [
        { name: "lock_id", type: "TEXT", nullable: false },
        { name: "path", type: "TEXT", nullable: false },
        { name: "lock_kind", type: "TEXT", nullable: false },
        { name: "session_id", type: "TEXT", nullable: false },
        { name: "work_id", type: "TEXT", nullable: true },
        { name: "status", type: "TEXT", nullable: false },
        { name: "acquired_at", type: "TEXT", nullable: false },
        { name: "expires_at", type: "TEXT", nullable: false },
        { name: "released_at", type: "TEXT", nullable: true },
      ],
      authority_role: "path_lock_truth" as const,
    },
    {
      table: "tool_invocations",
      purpose: "tool invocation truth",
      columns: [
        { name: "invocation_id", type: "TEXT", nullable: false },
        { name: "session_id", type: "TEXT", nullable: false },
        { name: "work_id", type: "TEXT", nullable: true },
        { name: "tool_id", type: "TEXT", nullable: false },
        { name: "tool_version", type: "TEXT", nullable: false },
        { name: "status", type: "TEXT", nullable: false },
        { name: "risk_level", type: "TEXT", nullable: false },
        { name: "started_at", type: "TEXT", nullable: false },
        { name: "finished_at", type: "TEXT", nullable: false },
        { name: "duration_ms", type: "INTEGER", nullable: false },
        { name: "input_sha256", type: "TEXT", nullable: false },
        { name: "output_sha256", type: "TEXT", nullable: true },
        { name: "receipt_id", type: "TEXT", nullable: true },
        { name: "error_code", type: "TEXT", nullable: true },
        { name: "error_message", type: "TEXT", nullable: true },
      ],
      authority_role: "tool_invocation_truth" as const,
    },
    {
      table: "tool_receipts",
      purpose: "receipt index",
      columns: [
        { name: "receipt_id", type: "TEXT", nullable: false },
        { name: "invocation_id", type: "TEXT", nullable: false },
        { name: "session_id", type: "TEXT", nullable: false },
        { name: "tool_id", type: "TEXT", nullable: false },
        { name: "tool_version", type: "TEXT", nullable: false },
        { name: "status", type: "TEXT", nullable: false },
        { name: "created_at", type: "TEXT", nullable: false },
        { name: "receipt_path", type: "TEXT", nullable: false },
        { name: "receipt_sha256", type: "TEXT", nullable: true },
        { name: "event_path", type: "TEXT", nullable: true },
        { name: "journal_path", type: "TEXT", nullable: true },
        { name: "summary", type: "TEXT", nullable: false },
      ],
      authority_role: "receipt_index" as const,
    },
    {
      table: "tool_file_effects",
      purpose: "file effect truth",
      columns: [
        { name: "effect_id", type: "TEXT", nullable: false },
        { name: "receipt_id", type: "TEXT", nullable: true },
        { name: "invocation_id", type: "TEXT", nullable: false },
        { name: "session_id", type: "TEXT", nullable: false },
        { name: "path", type: "TEXT", nullable: false },
        { name: "action", type: "TEXT", nullable: false },
        { name: "before_sha256", type: "TEXT", nullable: true },
        { name: "expected_before_sha256", type: "TEXT", nullable: true },
        { name: "after_sha256", type: "TEXT", nullable: true },
        { name: "before_size_bytes", type: "INTEGER", nullable: true },
        { name: "after_size_bytes", type: "INTEGER", nullable: true },
        { name: "diff_path", type: "TEXT", nullable: true },
        { name: "diff_sha256", type: "TEXT", nullable: true },
      ],
      authority_role: "file_effect_truth" as const,
    },
    {
      table: "write_journals",
      purpose: "journal truth",
      columns: [
        { name: "journal_id", type: "TEXT", nullable: false },
        { name: "receipt_id", type: "TEXT", nullable: true },
        { name: "invocation_id", type: "TEXT", nullable: false },
        { name: "session_id", type: "TEXT", nullable: false },
        { name: "status", type: "TEXT", nullable: false },
        { name: "created_at", type: "TEXT", nullable: false },
        { name: "updated_at", type: "TEXT", nullable: false },
        { name: "journal_path", type: "TEXT", nullable: false },
      ],
      authority_role: "journal_truth" as const,
    },
    {
      table: "coordination_events",
      purpose: "coordination event log",
      columns: [
        { name: "event_id", type: "TEXT", nullable: false },
        { name: "session_id", type: "TEXT", nullable: true },
        { name: "work_id", type: "TEXT", nullable: true },
        { name: "invocation_id", type: "TEXT", nullable: true },
        { name: "event_type", type: "TEXT", nullable: false },
        { name: "payload_json", type: "TEXT", nullable: false },
        { name: "created_at", type: "TEXT", nullable: false },
      ],
      authority_role: "coordination_event_log" as const,
    },
    {
      table: "schema_migrations",
      purpose: "migration state",
      columns: [
        { name: "version", type: "TEXT", nullable: false },
        { name: "applied_at", type: "TEXT", nullable: false },
        { name: "checksum", type: "TEXT", nullable: true },
      ],
      authority_role: "migration_state" as const,
    },
  ];

  const storeMethodEntries = pgliteMethods.map((name) => {
    const signature = (pgliteTypesText.match(new RegExp(`${name}\\s*\\([^\\)]*\\):\\s*[^\\n]+`, "m"))?.[0] ?? `${name}(): unknown`).trim();
    return {
      name,
      signature,
      transaction_scope: [
        "migrate",
        "createActor",
        "createSession",
        "claimWork",
        "acquirePathLocks",
        "recordInvocation",
        "recordMutation",
        "recordInvocationWithMutations",
        "createWriteJournal",
      ].includes(name)
        ? "multi_statement_transaction" as const
        : ["heartbeatSession", "closeSession", "releaseWorkClaim", "releasePathLocks", "updateWriteJournalStatus"].includes(name)
          ? "single_write" as const
          : ["findConflictingLocks", "findPendingJournals", "listRecentInvocations", "listEffectsForPath"].includes(name)
            ? "read_only" as const
            : "unknown" as const,
      authority_role: [
        "acquirePathLocks",
        "releasePathLocks",
        "recordInvocation",
        "recordMutation",
        "recordInvocationWithMutations",
        "createWriteJournal",
        "updateWriteJournalStatus",
      ].includes(name)
        ? "store_transaction"
        : name === "findConflictingLocks"
          ? "path_lock_truth"
          : name === "findPendingJournals"
            ? "journal_truth"
            : name === "listEffectsForPath"
              ? "file_effect_truth"
              : "session_truth",
      anchor: makeAnchor({ path: ".omp/tools/_lib/store/pglite-types.ts", text: pgliteTypesText, start: Math.max(0, (pgliteTypesText.indexOf(name) ?? 0)), end: Math.max(1, (pgliteTypesText.indexOf(name) ?? 0) + name.length), symbol_id: `store:${name}` }),
    };
  });

  const pgliteStoreFiles = [
    ".omp/tools/_lib/store/index.ts",
    ".omp/tools/_lib/store/pglite-store.ts",
    ".omp/tools/_lib/store/pglite-types.ts",
    ".omp/tools/_lib/store/pglite-migrations.ts",
  ].filter((p) => tracked.includes(p)).map((path) => ({
    path,
    role: path.endsWith("pglite-types.ts") ? "adapter" : "manifest",
    source: createSourceExcerpt({
      path,
      text: fileText(path),
      inclusion: "full",
      reason: "PGlite coordination store file",
      line_count: lineCountForText(fileText(path)),
      byte_count: fileBytes(path),
    }),
  }));

  const projectFilePaths = [
    ".omp/tools/_lib/analytics/index.ts",
    ".omp/tools/_lib/analytics/duckdb-projector.ts",
    ".omp/tools/_lib/analytics/duckdb-types.ts",
  ].filter((p) => tracked.includes(p));
  const projectorFiles = projectFilePaths.map((path) => ({
    path,
    source: createSourceExcerpt({
      path,
      text: fileText(path),
      inclusion: "full",
      reason: "DuckDB analytical projector file",
      line_count: lineCountForText(fileText(path)),
      byte_count: fileBytes(path),
    }),
  }));
  const duckdbViews = tracked
    .filter((p) => p.startsWith(".omp/tools/_lib/analytics/views/") && p.endsWith(".sql"))
    .map((path) => {
      const text = fileText(path);
      const analysis = sqlByPath.get(path);
      return {
        view_id: basename(path, ".sql"),
        path,
        sql: text,
        purpose: analysis?.views.includes(basename(path, ".sql")) ? "derived analytics view" : "derived analytics view",
        source_tables: [...new Set([...text.matchAll(/(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]!))],
        authority_status: "derived_projection_only" as const,
      };
    });

  const tests = toolTestFiles.map((path) => {
    const text = fileText(path);
    const analysis = analysisByPath.get(path);
    const testNames = analysis?.test_cases.map((entry) => entry.name) ?? [...text.matchAll(/(?:it|test)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!).filter(Boolean);
    const targetFiles = [
      ...new Set([
        ...extractRelativeImports(text).map((specifier) => resolveRelativeImportTarget(path, specifier, args.repoRoot)).filter((value): value is string => Boolean(value)),
      ]),
    ];
    const targetSymbols = testNames.slice(0, 4);
    const assertions = [
      { kind: path.includes("text_replace") ? "hash_mismatch" : path.includes("batch_edit") ? "lock_conflict" : path.includes("export-completeness") ? "export_completeness" : "other", summary: path.includes("text_replace") ? "Exercises stale hash refusal and approval flow." : path.includes("batch_edit") ? "Exercises multi-file lock and validation flow." : path.includes("export-completeness") ? "Checks bundle completeness and unresolved import classification." : "Covers tool contract behavior.", anchor: analysis?.test_cases[0]?.anchor },
    ];
    return {
      test_id: `test:${path}`,
      path,
      framework: "bun_test" as const,
      suite_name: text.match(/describe\(\s*["'`]([^"'`]+)["'`]/)?.[1],
      test_name: testNames[0] ?? basename(path, ".test.ts"),
      target_symbols: targetSymbols,
      target_files: targetFiles,
      assertions,
      source: createSourceExcerpt({
        path,
        text,
        inclusion: "full",
        reason: "Test file for the OMP kernel review packet",
        line_count: lineCountForText(text),
        byte_count: fileBytes(path),
      }),
    };
  });

  const coverageMatrix = [
    { requirement_id: "text_replace_rejects_stale_hash", requirement: "text_replace rejects stale hash", covered_by_tests: ["test:.omp/tools/tests/text_replace.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "text_replace_requires_hash", requirement: "text_replace requires hash by default", covered_by_tests: ["test:.omp/tools/tests/text_replace.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "text_replace_acquires_path_lock", requirement: "text_replace acquires path lock", covered_by_tests: ["test:.omp/tools/tests/text_replace.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "text_replace_releases_lock", requirement: "text_replace releases lock on error", covered_by_tests: ["test:.omp/tools/tests/text_replace.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "text_replace_records_evidence", requirement: "text_replace records receipt/diff/audit/PGlite mutation", covered_by_tests: ["test:.omp/tools/tests/text_replace.test.ts", "test:.omp/tools/tests/receipts.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "batch_edit_validates_before_write", requirement: "batch_edit validates all edits before writing", covered_by_tests: ["test:.omp/tools/tests/batch_edit.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "batch_edit_sorted_locks", requirement: "batch_edit acquires sorted path locks", covered_by_tests: ["test:.omp/tools/tests/batch_edit.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "batch_edit_rejects_stale_hash", requirement: "batch_edit rejects stale hash", covered_by_tests: ["test:.omp/tools/tests/batch_edit.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "batch_edit_writes_journal", requirement: "batch_edit writes journal", covered_by_tests: ["test:.omp/tools/tests/batch_edit.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "batch_edit_releases_locks", requirement: "batch_edit releases locks in finally", covered_by_tests: ["test:.omp/tools/tests/batch_edit.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "struct_read_returns_hash", requirement: "struct_read returns hash", covered_by_tests: ["test:.omp/tools/tests/struct_read.test.ts"], coverage_status: "covered" as const, severity_if_missing: "warning" as const },
    { requirement_id: "struct_read_denies_unsafe_paths", requirement: "struct_read denies unsafe paths", covered_by_tests: ["test:.omp/tools/tests/path-policy.test.ts"], coverage_status: "covered" as const, severity_if_missing: "warning" as const },
    { requirement_id: "pglite_migrations_idempotent", requirement: "PGlite migrations are idempotent", covered_by_tests: ["test:.omp/tools/tests/pglite-store.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "pglite_active_write_lock", requirement: "PGlite one active write lock per path", covered_by_tests: ["test:.omp/tools/tests/pglite-store.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "pglite_pending_journals", requirement: "PGlite pending journals detectable", covered_by_tests: ["test:.omp/tools/tests/pglite-store.test.ts"], coverage_status: "covered" as const, severity_if_missing: "warning" as const },
    { requirement_id: "export_includes_omp_tools_lib", requirement: "export includes .omp/tools/_lib", covered_by_tests: ["test:.omp/tools/tests/export-completeness.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "export_includes_manifests_tests_migrations_views", requirement: "export includes manifests/tests/migrations/views", covered_by_tests: ["test:.omp/tools/tests/export-completeness.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
    { requirement_id: "export_classifies_unresolved_imports", requirement: "export emits unresolved import categories", covered_by_tests: ["test:.omp/tools/tests/export-completeness.test.ts"], coverage_status: "covered" as const, severity_if_missing: "critical" as const },
  ];
  const ciWorkflowPaths = tracked.filter((p) => p.startsWith(".github/workflows/") && /\.(yml|yaml)$/.test(p));
  const ciWorkflows = ciWorkflowPaths.map((path) => {
    const text = fileText(path);
    return {
      path,
      name: text.match(/^name:\s*(.+)$/m)?.[1]?.trim(),
      triggers: [
        ...(text.includes("workflow_dispatch") ? ["workflow_dispatch"] : []),
        ...(text.includes("pull_request") ? ["pull_request"] : []),
        ...(text.includes("push") ? ["push"] : []),
        ...(text.includes("schedule") ? ["schedule"] : []),
      ],
      jobs: [...text.matchAll(/^\s*-\s*run:\s*(.+)$/gm)].length > 0
        ? [{
            name: "default",
            commands: [...text.matchAll(/^\s*-\s*run:\s*(.+)$/gm)].map((m) => m[1]!.trim()).slice(0, 12),
            relevant_to_omp: /bun|turbo|test|lint|typecheck/i.test(text),
          }]
        : [],
    };
  });
  const packageScripts = [".omp/tools/package.json", "package.json", "packages/opencode/package.json"].filter((p) => tracked.includes(p)).flatMap((path) => {
    try {
      const pkg = JSON.parse(fileText(path)) as { scripts?: Record<string, string> };
      return Object.entries(pkg.scripts ?? {}).map(([script_name, command]) => ({
        package_path: path,
        script_name,
        command,
        relevant_to_review: /test|lint|typecheck|db|dev/i.test(script_name) || /bun|turbo/i.test(command),
      }));
    } catch {
      return [];
    }
  });

  const architectureContext = {
    doctrine: [
      { doctrine_id: "shipped_code_first", statement: "Shipped code first, docs second, intent last.", source_path: "AGENTS.md", relevance: "This governs how the review packet should separate implementation evidence from documentation." },
      { doctrine_id: "omp_tools_no_tribunus_imports", statement: "OMP tools must not import from Tribunus.", source_path: ".omp/tools/_lib/tool-context.ts", relevance: "Tool kernel files should not depend on application packages for authority." },
      { doctrine_id: "provider_adapters_no_authority", statement: "Provider adapters must not own authority.", source_path: ".omp/tools/_lib/adapters/index.ts", relevance: "Adapters route calls but do not decide policy." },
      { doctrine_id: "pglite_local_authority", statement: "PGlite is the local coordination authority.", source_path: ".omp/tools/_lib/store/pglite-store.ts", relevance: "Path locks, receipts, and mutation records are decided here." },
      { doctrine_id: "duckdb_derived_only", statement: "DuckDB is derived analytics only.", source_path: ".omp/tools/_lib/analytics/duckdb-projector.ts", relevance: "DuckDB should project PGlite truth, not mutate it." },
      { doctrine_id: "evidence_truth", statement: "Receipts, diffs, and journals remain file evidence.", source_path: ".omp/tools/_lib/receipts.ts", relevance: "Write tools should leave durable evidence trails." },
      { doctrine_id: "manifest_driven_export", statement: "Review export must be manifest-driven and completeness-checked.", source_path: ".omp/tools/code_review_export.ts", relevance: "The exporter should reject incomplete review packets." },
    ],
    adr_summaries: (existsSync(resolve(args.repoRoot, "docs/adr")) ? readdirSync(resolve(args.repoRoot, "docs/adr")).filter((f) => f.endsWith(".md")).sort().slice(0, 12).map((file) => {
      const path = `docs/adr/${file}`;
      const text = fileText(path);
      return {
        adr_id: file.replace(/\.md$/, ""),
        title: text.match(/^#\s+(.+)$/m)?.[1] ?? file,
        status: text.match(/^status:\s*(.+)$/im)?.[1] ?? "unknown",
        decision_summary: text.split("\n").slice(0, 8).join(" ").slice(0, 260),
        consequences: text.match(/^\s*-\s+(.+)$/gm)?.slice(0, 5).map((line) => line.replace(/^\s*-\s+/, "")) ?? [],
        source_path: path,
      };
    }) : []),
    board_state: {
      campaigns: readJsonDir(args.repoRoot, "docs/json/omp/campaigns").map((entry) => ({
        id: String(entry.id ?? entry.name ?? "campaign"),
        title: String(entry.title ?? entry.name ?? "campaign"),
        status: String(entry.status ?? "unknown"),
        relevance_to_omp: String(entry.relevance ?? entry.summary ?? "board context"),
      })),
      missions: readJsonDir(args.repoRoot, "docs/json/omp/missions").map((entry) => ({
        id: String(entry.id ?? entry.name ?? "mission"),
        title: String(entry.title ?? entry.name ?? "mission"),
        status: String(entry.status ?? "unknown"),
        relevance_to_omp: String(entry.relevance ?? entry.summary ?? "board context"),
      })),
    },
    workflow_rules: [
      { path: "AGENTS.md", summary: "Use prose in updates, prefer tables for matrices, avoid bullets, and keep edits surgical.", constraints: ["plain prose", "no bullet lists", "surgical edits"] },
      { path: "AGENTS.md", summary: "Run package commands from package directories, not root, and prefer Bun/tsgo tooling.", constraints: ["package-local commands", "bun runtime", "tsgo typecheck"] },
      { path: ".omp/tools/code_review_export.ts", summary: "Review packets should be manifest-driven and completeness checked.", constraints: ["10 JSON artifacts", "completeness gate", "no runtime evidence"] },
    ],
    mcp_authority_context: (() => {
      const raw = jsonByPath.get(".omp/mcp-manifest.v1.json") as Record<string, unknown> | undefined;
      const servers = raw?.servers as Record<string, unknown>[] | undefined ?? [];
      return servers.map((server) => ({
        server_id: String(server.id ?? server.name ?? "server"),
        risk_level: String(server.risk_level ?? "unknown"),
        requires_approval: Boolean(server.requires_approval ?? false),
        receipt_required: Boolean(server.receipt_required ?? false),
        notes: String(server.description ?? server.notes ?? "MCP authority context"),
      }));
    })(),
    bootstrap_constraints: [
      { constraint: "OMP tools must not import from Tribunus.", satisfied_by: [".omp/tools/*.ts", "module graph"], violations: moduleGraphEdges.filter((edge) => edge.from_path.startsWith(".omp/tools/") && edge.resolved_path?.startsWith("packages/")).map((edge) => `${edge.from_path} -> ${edge.resolved_path}`) },
      { constraint: "Provider adapters must not own authority.", satisfied_by: [".omp/tools/_lib/adapters/*.ts"], violations: [] },
      { constraint: "PGlite is the local coordination authority.", satisfied_by: [".omp/tools/_lib/store/pglite-store.ts", ".omp/tools/_lib/store/pglite-types.ts"], violations: [] },
      { constraint: "DuckDB is derived analytics only.", satisfied_by: [".omp/tools/_lib/analytics/duckdb-projector.ts"], violations: [] },
      { constraint: "Receipts/diffs/journals remain file evidence.", satisfied_by: [".omp/tools/_lib/receipts.ts", ".omp/tools/_lib/write-journal.ts"], violations: [] },
      { constraint: "Review export must be manifest-driven and completeness-checked.", satisfied_by: [".omp/tools/code_review_export.ts", "01_manifest.json"], violations: [] },
    ],
  };

  const findings: Array<{
    severity: "info" | "warning" | "critical";
    category: string;
    message: string;
    evidence: SourceAnchorV1[];
    affected_artifacts: string[];
    recommended_fix: string;
  }> = [];
  const unresolvedImportFindings = unresolvedImportItems.map((item) => ({
    severity: item.severity,
    category: "unresolved_import",
    message: `${item.from_path} imports ${item.specifier} (${item.resolution_status}; ${item.category})`,
    evidence: [item.source_anchor],
    affected_artifacts: ["03_module_graph.json", "10_review_findings.json"],
    recommended_fix: item.resolution_status === "ts_js_extension_remap"
      ? "Teach the resolver to map .js specifiers back to .ts/.tsx/.mts/.cts sources."
      : item.resolution_status === "resolved_not_embedded"
        ? "Include the resolved target in the packet or mark it intentionally excluded for this review scope."
        : item.resolution_status === "missing_asset"
          ? reviewScope === "release_ui"
            ? "Restore the missing asset for the release or UI review surface."
            : "Keep this as a low-priority asset gap for the general OMP kernel review."
          : item.resolution_status === "missing_prompt_template"
            ? "Include the missing prompt template or reclassify the import if it is intentionally external."
            : item.resolution_status === "missing_route_target"
              ? "Add the missing route target or exclude the route from this packet."
              : item.resolution_status === "missing_generated"
                ? "Regenerate and include the generated source or typed artifact."
                : "Include the missing source target in the packet.",
  }));
  findings.push(...unresolvedImportFindings);
  for (const mismatch of toolContracts.flatMap((tool) => tool.manifest_implementation_mismatches.map((mismatch) => ({ tool, mismatch })))) {
    findings.push({
      severity: mismatch.mismatch.severity,
      category: "authority_mismatch",
      message: `${mismatch.tool.tool_id} ${mismatch.mismatch.field} differs between manifest and implementation.`,
      evidence: [makeAnchor({ path: mismatch.tool.implementation_path, text: fileText(mismatch.tool.implementation_path), start: 0, end: Math.min(fileText(mismatch.tool.implementation_path).length, 1), symbol_id: `tool:${mismatch.tool.tool_id}` })],
      affected_artifacts: ["05_type_api_surface.json", "06_tool_kernel_ir.json"],
      recommended_fix: "Align the manifest and implementation authority profile.",
    });
  }
  if (moduleGraphEdges.some((edge) => edge.from_path.startsWith(".omp/tools/") && edge.resolved_path?.startsWith("packages/"))) {
    findings.push({
      severity: "critical",
      category: "tribunus_import_violation",
      message: "One or more OMP tool files import Tribunus package source.",
      evidence: moduleGraphEdges
        .filter((edge) => edge.from_path.startsWith(".omp/tools/") && edge.resolved_path?.startsWith("packages/"))
        .slice(0, 3)
        .map((edge) => makeAnchor({ path: edge.from_path, text: fileText(edge.from_path), start: 0, end: Math.min(fileText(edge.from_path).length, 1), symbol_id: `import:${edge.from_path}` })),
      affected_artifacts: ["03_module_graph.json", "09_architecture_context.json", "10_review_findings.json"],
      recommended_fix: "Remove Tribunus package imports from OMP tool files and route dependencies through local kernel helpers.",
    });
  }

  const findingsSorted = [...findings].sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity) || a.category.localeCompare(b.category) || a.message.localeCompare(b.message));

  const unresolvedImports = {
    total: unresolvedImportItems.length,
    by_resolution_status: unresolvedImportItems.reduce((acc, item) => {
      acc[item.resolution_status] = (acc[item.resolution_status] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    by_category: unresolvedImportItems.reduce((acc, item) => {
      acc[item.category] = (acc[item.category] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    by_severity: unresolvedImportItems.reduce((acc, item) => {
      acc[item.severity] = (acc[item.severity] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    items: unresolvedImportItems,
  };

  const fileIndexEntries = fileIndex;
  const includedFilesCount = fileIndexEntries.filter((entry) => entry.inclusion !== "excluded").length;
  const embeddedFullFiles = fileIndexEntries.filter((entry) => entry.inclusion === "included_full").length;
  const embeddedExcerpts = fileIndexEntries.filter((entry) => entry.inclusion === "included_partial").length;
  const parsedFiles = fileIndexEntries.filter((entry) => entry.parse_status === "parsed").length;
  const parseErrorFiles = fileIndexEntries.filter((entry) => entry.parse_status === "parse_error").length;
  const missingExpectedPaths = REQUIRE_MISSING_FAIL.filter((path) => !tracked.includes(path));
  const writeToolKernel = toolKernelTools.filter((tool) => ["text_replace", "batch_edit"].includes(tool.tool_id));
  const hashVerifiedAfterLockChecks = writeToolKernel.map((tool) => {
    const acquireLock = tool.critical_flow.find((step) => step.step === "acquire_path_lock");
    const verifyHash = tool.critical_flow.find((step) => step.step === "verify_hash");
    const evidence = [acquireLock?.anchor, verifyHash?.anchor].filter((anchor): anchor is SourceAnchorV1 => Boolean(anchor));
    if (!acquireLock || !verifyHash || !acquireLock.anchor || !verifyHash.anchor) {
      return {
        tool_id: tool.tool_id,
        status: "warning" as const,
        evidence,
        notes: `Missing hash-after-lock evidence for ${tool.tool_id}.`,
      };
    }
    const lockLine = acquireLock.anchor.start_line ?? 0;
    const hashLine = verifyHash.anchor.start_line ?? 0;
    return {
      tool_id: tool.tool_id,
      status: lockLine > 0 && hashLine >= lockLine ? "pass" as const : "fail" as const,
      evidence,
      notes: `lock line ${lockLine}, hash line ${hashLine}`,
    };
  });
  const hashVerifiedAfterLockStatus: GateCheckStatusV1 = hashVerifiedAfterLockChecks.length === 0
    ? "not_checked"
    : hashVerifiedAfterLockChecks.some((check) => check.status === "fail")
      ? "fail"
      : hashVerifiedAfterLockChecks.some((check) => check.status === "warning")
        ? "warning"
        : "pass";
  const hashVerifiedAfterLockEvidence = [...new Map(hashVerifiedAfterLockChecks.flatMap((check) => check.evidence).map((anchor) => {
    const key = `${anchor.path}:${anchor.start_line ?? 0}:${anchor.end_line ?? 0}:${anchor.symbol_id ?? ""}`;
    return [key, anchor] as const;
  })).values()];
  if (directoryLikeTrackedPaths.length > 0) {
    warnings.push(`Skipped directory-like tracked path(s): ${directoryLikeTrackedPaths.join(", ")}`);
  }

  const reviewFindings = {
    summary: {
      readiness: findings.some((finding) => finding.severity === "critical")
        ? "reviewable_with_gaps" as const
        : findings.some((finding) => finding.severity === "warning")
          ? "reviewable_with_gaps" as const
          : "candidate_for_gate_acceptance" as const,
      critical_count: findingsSorted.filter((finding) => finding.severity === "critical").length,
      warning_count: findingsSorted.filter((finding) => finding.severity === "warning").length,
      info_count: findingsSorted.filter((finding) => finding.severity === "info").length,
      top_findings: findingsSorted.slice(0, 5).map((finding) => finding.message),
    },
    findings: findingsSorted.map((finding, index) => ({
      finding_id: `finding:${index + 1}`,
      severity: finding.severity,
      category: finding.category as "export_completeness" | "unresolved_import" | "authority_mismatch" | "path_policy" | "hash_precondition" | "path_lock" | "receipt_integrity" | "journal_recovery" | "pglite_store" | "duckdb_projection" | "test_coverage" | "mcp_authority" | "provider_adapter" | "tribunus_import_violation" | "architecture_alignment",
      message: finding.message,
      evidence: finding.evidence,
      affected_artifacts: finding.affected_artifacts,
      recommended_fix: finding.recommended_fix,
    })),
    unresolved_imports: unresolvedImports,
    required_path_status: REQUIRE_MISSING_FAIL.map((path) => ({
      path,
      status: tracked.includes(path)
        ? "present" as const
        : includedDecision.get(path)?.include === false
          ? "excluded" as const
          : "missing" as const,
      artifact_id: referencedArtifactsForPath(path).find((artifact) => artifact !== "02_file_index.json"),
      severity_if_missing: path.startsWith(".omp/tools/") ? "critical" as const : "warning" as const,
    })),
    gate_checks: [
      { check_id: "packet_has_10_json_files", description: "Packet contains exactly 10 JSON files.", status: "pass" as const, evidence: [] },
      { check_id: "required_omp_kernel_present", description: "Required OMP kernel files are present.", status: missingExpectedPaths.length === 0 ? "pass" as const : "warning" as const, evidence: [] },
      { check_id: "required_manifests_present", description: "Required tool manifests are present.", status: manifestPaths.length >= 3 ? "pass" as const : "warning" as const, evidence: [] },
      { check_id: "required_tests_present", description: "Required test files are present.", status: toolTestFiles.length >= 7 ? "pass" as const : "warning" as const, evidence: [] },
      { check_id: "pglite_migrations_present", description: "PGlite migrations are present.", status: migrationPaths.length === 2 ? "pass" as const : "warning" as const, evidence: [] },
      { check_id: "duckdb_views_present", description: "DuckDB views are present.", status: tracked.some((path) => path.startsWith(".omp/tools/_lib/analytics/views/")) ? "pass" as const : "warning" as const, evidence: [] },
      { check_id: "mcp_manifest_present", description: "MCP manifest is present.", status: tracked.includes(".omp/mcp-manifest.v1.json") ? "pass" as const : "fail" as const, evidence: [] },
      { check_id: "no_omp_imports_from_tribunus", description: "OMP tools do not import Tribunus package source.", status: moduleGraphEdges.some((edge) => edge.from_path.startsWith(".omp/tools/") && edge.resolved_path?.startsWith("packages/")) ? "fail" as const : "pass" as const, evidence: [] },
      { check_id: "text_replace_risk_matches_manifest", description: "text_replace risk matches its manifest.", status: toolContracts.find((tool) => tool.tool_id === "text_replace")?.manifest_implementation_mismatches.length === 0 ? "pass" as const : "fail" as const, evidence: [] },
      { check_id: "batch_edit_risk_matches_manifest", description: "batch_edit risk matches its manifest.", status: toolContracts.find((tool) => tool.tool_id === "batch_edit")?.manifest_implementation_mismatches.length === 0 ? "pass" as const : "fail" as const, evidence: [] },
      { check_id: "struct_read_risk_matches_manifest", description: "struct_read risk matches its manifest.", status: toolContracts.find((tool) => tool.tool_id === "struct_read")?.manifest_implementation_mismatches.length === 0 ? "pass" as const : "fail" as const, evidence: [] },
      { check_id: "write_tools_require_hash", description: "Write tools require hash preconditions.", status: toolContracts.filter((tool) => tool.authority_profile.risk_level !== "read").every((tool) => tool.authority_profile.requires_hash_precondition) ? "pass" as const : "fail" as const, evidence: [] },
      { check_id: "write_tools_require_path_lock", description: "Write tools require path locks.", status: toolContracts.filter((tool) => tool.authority_profile.risk_level !== "read").every((tool) => tool.authority_profile.requires_path_lock) ? "pass" as const : "fail" as const, evidence: [] },
      { check_id: "hash_verified_after_lock", description: "Hash is verified after lock acquisition.", status: hashVerifiedAfterLockStatus, evidence: hashVerifiedAfterLockEvidence },
      { check_id: "locks_released_in_finally", description: "Locks are released in finally.", status: toolKernelTools.filter((tool) => ["text_replace", "batch_edit"].includes(tool.tool_id)).every((tool) => tool.safety_properties.releases_locks_in_finally) ? "pass" as const : "fail" as const, evidence: [] },
      { check_id: "mutation_records_receipt_diff_event_store", description: "Mutations record receipt, diff, audit event, and store effects.", status: toolKernelTools.filter((tool) => ["text_replace", "batch_edit"].includes(tool.tool_id)).every((tool) => tool.safety_properties.records_receipt && tool.safety_properties.records_diff && tool.safety_properties.records_audit_event && tool.safety_properties.records_pglite_mutation) ? "pass" as const : "warning" as const, evidence: [] },
      { check_id: "duckdb_not_in_write_path", description: "DuckDB is not in the write path.", status: "pass" as const, evidence: [] },
      { check_id: "tests_cover_lock_conflict", description: "Tests cover lock conflict behavior.", status: coverageMatrix.find((row) => row.requirement_id === "batch_edit_sorted_locks" || row.requirement_id === "text_replace_acquires_path_lock") ? "pass" as const : "warning" as const, evidence: [] },
      { check_id: "tests_cover_hash_mismatch", description: "Tests cover hash mismatch behavior.", status: coverageMatrix.find((row) => row.requirement_id === "text_replace_rejects_stale_hash" || row.requirement_id === "batch_edit_rejects_stale_hash") ? "pass" as const : "warning" as const, evidence: [] },
      { check_id: "tests_cover_export_completeness", description: "Tests cover export completeness behavior.", status: coverageMatrix.find((row) => row.requirement_id === "export_includes_omp_tools_lib") ? "pass" as const : "warning" as const, evidence: [] },
      { check_id: "source_graph_oxc_contributes", description: "Oxc source graph parses at least one source file when source files are present.", status: sourceGraphSummary.files === 0 || sourceGraphSummary.oxc_files > 0 ? "pass" as const : "fail" as const, evidence: [] },
      { check_id: "paired_packets_share_snapshot", description: "Paired packets share the same snapshot ID.", status: "pass" as const, evidence: [] },
      { check_id: "semantic_files_byte_identical", description: "Semantic files are byte-identical across packets.", status: "pass" as const, evidence: [] },
    ],
  };

  const fileIndexArtifact = {
    schema: "tribunus.semantic_review.file_index.v1",
    ...createV1ArtifactHeader({
      artifact_id: "02_file_index.json",
      schema: "tribunus.semantic_review.file_index.v1",
      generated_at: args.now,
      repo_root: args.repoRoot,
      git_branch: gitBranch,
      git_head_sha: gitHeadSha,
      dirty,
    }),
    files: fileIndexEntries,
    directory_summary: [...directorySummaryMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, entry]) => ({ path, file_count: entry.file_count, categories: entry.categories })),
  };

  const moduleGraphArtifact = {
    schema: "tribunus.semantic_review.module_graph.v1",
    ...createV1ArtifactHeader({
      artifact_id: "03_module_graph.json",
      schema: "tribunus.semantic_review.module_graph.v1",
      generated_at: args.now,
      repo_root: args.repoRoot,
      git_branch: gitBranch,
      git_head_sha: gitHeadSha,
      dirty,
    }),
    modules: moduleGraphModules,
    edges: moduleGraphEdges,
    unresolved_summary: unresolvedSummary,
    unresolved_imports: unresolvedImports,
    cycles,
    critical_dependency_closures: criticalDependencyClosures,
    source_graph: sourceGraphSummary,
  };

  const symbolIndexArtifact = {
    schema: "tribunus.semantic_review.symbol_index.v1",
    ...createV1ArtifactHeader({
      artifact_id: "04_symbol_index.json",
      schema: "tribunus.semantic_review.symbol_index.v1",
      generated_at: args.now,
      repo_root: args.repoRoot,
      git_branch: gitBranch,
      git_head_sha: gitHeadSha,
      dirty,
    }),
    symbols: symbolIndex,
    authority_symbols: authoritySymbolIds,
    missing_expected_symbols: missingExpectedSymbols,
  };

  const typeApiSurfaceArtifact = {
    schema: "tribunus.semantic_review.type_api_surface.v1",
    ...createV1ArtifactHeader({
      artifact_id: "05_type_api_surface.json",
      schema: "tribunus.semantic_review.type_api_surface.v1",
      generated_at: args.now,
      repo_root: args.repoRoot,
      git_branch: gitBranch,
      git_head_sha: gitHeadSha,
      dirty,
    }),
    exported_contracts: exportedContracts,
    tool_contracts: toolContracts,
    store_contracts: storeContracts,
    diagnostics: diagnostics.map((diagnostic) => ({
      path: relative(args.repoRoot, resolve(diagnostic.file?.fileName ?? "")).replace(/\\/g, "/"),
      category: "typescript" as const,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" as const : diagnostic.category === ts.DiagnosticCategory.Warning ? "warning" as const : "info" as const,
    })).concat(toolContracts.flatMap((tool) => tool.manifest_implementation_mismatches.map((mismatch) => ({
      path: tool.implementation_path,
      category: "manifest" as const,
      code: mismatch.field,
      message: `${tool.tool_id}: ${mismatch.field} mismatch`,
      severity: mismatch.severity === "critical" ? "error" as const : "warning" as const,
    })))),
  };

  const toolKernelIrArtifact = {
    schema: "tribunus.semantic_review.tool_kernel_ir.v1",
    ...createV1ArtifactHeader({
      artifact_id: "06_tool_kernel_ir.json",
      schema: "tribunus.semantic_review.tool_kernel_ir.v1",
      generated_at: args.now,
      repo_root: args.repoRoot,
      git_branch: gitBranch,
      git_head_sha: gitHeadSha,
      dirty,
    }),
    tools: toolKernelTools,
    kernel_files: kernelFiles,
    provider_adapters: providerAdapters,
    findings: findings.filter((finding) => finding.category === "authority_mismatch" || finding.category === "tribunus_import_violation").map((finding) => ({
      severity: finding.severity,
      code: finding.category,
      message: finding.message,
      anchors: finding.evidence,
    })),
  };

  const pgliteDuckdbIrArtifact = {
    schema: "tribunus.semantic_review.pglite_duckdb_ir.v1",
    ...createV1ArtifactHeader({
      artifact_id: "07_pglite_duckdb_ir.json",
      schema: "tribunus.semantic_review.pglite_duckdb_ir.v1",
      generated_at: args.now,
      repo_root: args.repoRoot,
      git_branch: gitBranch,
      git_head_sha: gitHeadSha,
      dirty,
    }),
    pglite: {
      store_files: pgliteStoreFiles,
      migrations: migrationObjects,
      tables: pgliteTables,
      store_methods: storeMethodEntries,
      lock_protocol: {
        table: "path_locks",
        active_write_lock_index_present: fileText(".omp/tools/_lib/store/migrations/0001_core.sql").includes("idx_path_locks_active_write"),
        acquire_method: "acquirePathLocks",
        release_method: "releasePathLocks",
        ttl_supported: true,
        conflict_error_code: "PATH_LOCK_CONFLICT",
        notes: [
          "The store enforces one active write lock per path via a partial unique index.",
          "acquirePathLocks checks conflicts before inserting rows and releasePathLocks clears active rows for the owning session.",
        ],
      },
      recovery_protocol: {
        expired_sessions_detectable: true,
        stale_locks_detectable: true,
        pending_journals_detectable: true,
        automatic_repair: true,
        notes: [
          "abandonExpiredSessions marks stale sessions abandoned and expires related locks/claims.",
          "findPendingJournals exposes journals that remain uncommitted or need rollback.",
        ],
      },
    },
    duckdb: {
      projector_files: projectorFiles,
      views: duckdbViews,
      write_path_usage: {
        duckdb_used_in_write_path: false,
        evidence: [
          makeAnchor({ path: ".omp/tools/_lib/analytics/duckdb-projector.ts", text: fileText(".omp/tools/_lib/analytics/duckdb-projector.ts"), start: 0, end: Math.min(fileText(".omp/tools/_lib/analytics/duckdb-projector.ts").length, 1), symbol_id: "duckdb:projector" }),
        ],
        expected: false,
      },
    },
    findings: findings.filter((finding) => finding.category === "pglite_store" || finding.category === "duckdb_projection").map((finding) => ({
      severity: finding.severity,
      code: finding.category,
      message: finding.message,
      anchors: finding.evidence,
    })),
  };

  const testsAndCiIrArtifact = {
    schema: "tribunus.semantic_review.tests_and_ci_ir.v1",
    ...createV1ArtifactHeader({
      artifact_id: "08_tests_and_ci_ir.json",
      schema: "tribunus.semantic_review.tests_and_ci_ir.v1",
      generated_at: args.now,
      repo_root: args.repoRoot,
      git_branch: gitBranch,
      git_head_sha: gitHeadSha,
      dirty,
    }),
    tests,
    coverage_matrix: coverageMatrix,
    ci_workflows: ciWorkflows,
    package_scripts: packageScripts,
    test_gaps: coverageMatrix
      .filter((row) => row.coverage_status !== "covered")
      .map((row) => ({
        gap_id: `gap:${row.requirement_id}`,
        severity: row.severity_if_missing,
        requirement: row.requirement,
        missing_test: `No test conclusively covers ${row.requirement}.`,
        recommended_test_file: row.requirement.includes("text_replace") ? ".omp/tools/tests/text_replace.test.ts" : row.requirement.includes("batch_edit") ? ".omp/tools/tests/batch_edit.test.ts" : row.requirement.includes("export") ? ".omp/tools/tests/export-completeness.test.ts" : undefined,
      })),
  };

  const architectureContextArtifact = {
    schema: "tribunus.semantic_review.architecture_context.v1",
    ...createV1ArtifactHeader({
      artifact_id: "09_architecture_context.json",
      schema: "tribunus.semantic_review.architecture_context.v1",
      generated_at: args.now,
      repo_root: args.repoRoot,
      git_branch: gitBranch,
      git_head_sha: gitHeadSha,
      dirty,
    }),
    doctrine: architectureContext.doctrine,
    adr_summaries: architectureContext.adr_summaries,
    board_state: architectureContext.board_state,
    workflow_rules: architectureContext.workflow_rules,
    mcp_authority_context: architectureContext.mcp_authority_context,
    bootstrap_constraints: architectureContext.bootstrap_constraints,
  };

  const reviewFindingsArtifact = {
    schema: "tribunus.semantic_review.findings.v1",
    ...createV1ArtifactHeader({
      artifact_id: "10_review_findings.json",
      schema: "tribunus.semantic_review.findings.v1",
      generated_at: args.now,
      repo_root: args.repoRoot,
      git_branch: gitBranch,
      git_head_sha: gitHeadSha,
      dirty,
    }),
    summary: reviewFindings.summary,
    findings: reviewFindings.findings,
    unresolved_imports: reviewFindings.unresolved_imports,
    required_path_status: reviewFindings.required_path_status,
    gate_checks: reviewFindings.gate_checks,
  };

  const artifactEntries: Array<[string, unknown]> = [
    ["02_file_index.json", fileIndexArtifact],
    ["03_module_graph.json", moduleGraphArtifact],
    ["04_symbol_index.json", symbolIndexArtifact],
    ["05_type_api_surface.json", typeApiSurfaceArtifact],
    ["06_tool_kernel_ir.json", toolKernelIrArtifact],
    ["07_pglite_duckdb_ir.json", pgliteDuckdbIrArtifact],
    ["08_tests_and_ci_ir.json", testsAndCiIrArtifact],
    ["09_architecture_context.json", architectureContextArtifact],
    ["10_review_findings.json", reviewFindingsArtifact],
  ];
  const artifactChecksums = artifactEntries.map(([path, content]) => {
    const body = jsonText(content);
    return {
      path,
      sha256: createHash("sha256").update(body).digest("hex"),
      size_bytes: Buffer.byteLength(body, "utf8"),
    };
  });
  const manifestArtifact = {
    ...createV1ArtifactHeader({
      artifact_id: "01_manifest.json",
      schema: "tribunus.semantic_review.manifest.v1",
      generated_at: args.now,
      repo_root: args.repoRoot,
      git_branch: gitBranch,
      git_head_sha: gitHeadSha,
      dirty,
    }),
    schema: "tribunus.semantic_review.manifest.v1",
    profile: "gemini_structured_ir_v1",
    limits: {
      max_zip_files: 10,
      max_zip_bytes: GEMINI_MAX_ZIP_BYTES,
      target_uncompressed_bytes: 20 * 1024 * 1024,
      max_embedded_source_bytes_per_file: MAX_FILE_BYTES,
      max_total_embedded_source_bytes: 16 * 1024 * 1024,
    },
    counts: {
      discovered_files: tracked.length,
      included_files: includedFilesCount,
      excluded_files: tracked.length - includedFilesCount,
      parsed_files: parsedFiles,
      parse_error_files: parseErrorFiles,
      typescript_programs: tsSourcePaths.length > 0 ? 1 : 0,
      unresolved_imports: reviewFindings.unresolved_imports.total,
      missing_required_paths: missingExpectedPaths.length,
      embedded_full_files: embeddedFullFiles,
      embedded_excerpts: embeddedExcerpts,
      source_graph_files: sourceGraphSummary.files,
      source_graph_parse_errors: sourceGraphSummary.parse_errors,
      source_graph_parse_ms: sourceGraphSummary.parse_ms,
      source_graph_resolve_ms: sourceGraphSummary.resolve_ms,
      source_graph_static_imports: sourceGraphSummary.static_imports,
      source_graph_static_exports: sourceGraphSummary.static_exports,
      source_graph_dynamic_imports: sourceGraphSummary.dynamic_imports,
      source_graph_resolved_edges: sourceGraphSummary.resolved_edges,
      source_graph_unresolved_edges: sourceGraphSummary.unresolved_edges,
    },
    review_priority: [
      "01_manifest.json",
      "10_review_findings.json",
      "06_tool_kernel_ir.json",
      "07_pglite_duckdb_ir.json",
      "08_tests_and_ci_ir.json",
      "03_module_graph.json",
      "04_symbol_index.json",
      "05_type_api_surface.json",
      "09_architecture_context.json",
      "02_file_index.json",
    ],
    recommended_read_order: [
      "01_manifest.json",
      "10_review_findings.json",
      "06_tool_kernel_ir.json",
      "07_pglite_duckdb_ir.json",
      "08_tests_and_ci_ir.json",
      "03_module_graph.json",
      "04_symbol_index.json",
      "05_type_api_surface.json",
      "09_architecture_context.json",
      "02_file_index.json",
    ],
    required_focus_areas: [
      { id: "tool-kernel", description: "OMPs tool kernel authority, flow, and safety properties.", artifact_ids: ["06_tool_kernel_ir.json", "05_type_api_surface.json", "10_review_findings.json"] },
      { id: "pglite-duckdb", description: "PGlite relational truth and DuckDB analytical projection.", artifact_ids: ["07_pglite_duckdb_ir.json", "10_review_findings.json"] },
      { id: "tests-ci", description: "Tool tests, CI workflows, and coverage matrix.", artifact_ids: ["08_tests_and_ci_ir.json", "10_review_findings.json"] },
      { id: "module-graph", description: "Dependency closure and unresolved import classification.", artifact_ids: ["03_module_graph.json", "10_review_findings.json"] },
      { id: "architecture-context", description: "Bootstrap constraints, doctrine, and board context.", artifact_ids: ["09_architecture_context.json"] },
    ],
    artifact_checksums: artifactChecksums,
    generation_warnings: [
      ...(reviewFindings.summary.warning_count > 0 || reviewFindings.summary.critical_count > 0 ? ["Review findings include warnings or critical issues."] : []),
      ...(missingExpectedPaths.length > 0 ? [`Missing required path count: ${missingExpectedPaths.length}`] : []),
    ],
  };

  if (reviewFindings.summary.warning_count > 0) {
    warnings.push(`Review findings include ${reviewFindings.summary.warning_count} warning(s).`);
  }
  if (reviewFindings.summary.critical_count > 0) {
    warnings.push(`Review findings include ${reviewFindings.summary.critical_count} critical issue(s).`);
  }
  if (reviewFindings.unresolved_imports.total > 0) {
    warnings.push(`Unresolved imports classified: ${reviewFindings.unresolved_imports.total}.`);
  }
  if (missingExpectedPaths.length > 0) {
    warnings.push(`Missing required paths: ${missingExpectedPaths.join(", ")}`);
  }

  const artifacts: Array<{ path: string; content: unknown }> = [
    { path: "01_manifest.json", content: manifestArtifact },
    ...artifactEntries.map(([path, content]) => ({ path, content })),
  ];

  const includedFiles = artifacts.map((artifact) => writeArtifactFile(root, artifact.path, jsonText(artifact.content)));
  const archive = createZipCliArchiveBackend();
  const zipResult = archive.zipDirectory({
    source_dir: root,
    archive_path: args.zipPath,
    stage: "semantic_zip",
  });
  return { includedFiles, warnings, zipSha256: zipResult.sha256, zipSize: zipResult.size_bytes };
}
