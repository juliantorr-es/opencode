// ─── Review Export Bootstrap Builder ──────────────────────────────────
//
// Extracted from code_review_export.ts. Handles the bootstrap_review and
// gemini_code_review profiles: file collection, inclusion policy, staging,
// zip creation, and manifest generation.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  renameSync,
} from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import type {
  CodeReviewPacketManifestV1,
  FileEntry,
  ExclusionEntry,
  ImportFinding,
} from "./types.js";
import {
  REQUIRE_MISSING_FAIL,
  MAX_FILE_BYTES,
  GEMINI_MAX_FILE_COUNT,
  GEMINI_MAX_ZIP_BYTES,
  getPacketRoot,
  getZipName,
  validateGeminiBundle,
} from "./constants.js";
import {
  formatBytes,
  sourceLikeExtensions,
  collectRelativeImportSpecifiers,
} from "./fs-utils.js";
import {
  shouldIncludePath,
  INCLUDE_EXTENSIONS,
  INCLUDE_FILENAMES,
  INCLUDE_FILENAME_PREFIXES,
  INCLUDE_DIR_PREFIXES,
  INCLUDE_DIR_PATTERNS,
  HARD_EXCLUDE_SEGMENTS,
  HARD_EXCLUDE_PREFIXES,
  HARD_EXCLUDE_FILENAMES,
  HARD_EXCLUDE_EXTENSIONS,
} from "./policy.js";
import { classifyImportFinding, resolveImportCandidates } from "./import-analysis.js";
import { createZipCliArchiveBackend } from "./archive.js";
import { buildTree } from "./tree.js";
import { gitExec } from "./git.js";
import type { ReviewExportProgressEventV1 } from "./progress.js";

// ─── Result Types ──────────────────────────────────────────────────────

export interface BuildCodeReviewExportOptions {
  repoRoot: string;
  profile: "bootstrap_review" | "gemini_code_review";
  outputPath?: string;
  includeUntracked?: boolean;
  onProgress?: (event: ReviewExportProgressEventV1) => void;
  signal?: AbortSignal;
}

export interface BuildCodeReviewExportResult {
  includedFiles: FileEntry[];
  warnings: string[];
  exclusionEntries: ExclusionEntry[];
  oversizedFiles: ExclusionEntry[];
  missingExpected: Array<{
    path: string;
    status: "missing" | "excluded" | "oversized";
    reason?: string;
  }>;
  importFindings: ImportFinding[];
  zipSha256: string;
  zipPath: string;
  zipSize: number;
  gitBranch?: string;
  gitHeadSha?: string;
  isDirty: boolean;
  gitDiffPath?: string;
  manifest: CodeReviewPacketManifestV1;
  adrsJson: Record<string, unknown>[];
  adrsMarkdown: Array<{ name: string; content: string }>;
  campaigns: Record<string, unknown>[];
  missions: Record<string, unknown>[];
  lanes: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  research: Record<string, unknown>[];
  memoryLinks: Record<string, unknown>[];
  timingsMs: Record<string, number>;
}

// ─── Internal Helpers ──────────────────────────────────────────────────

function readJsonDir(
  worktree: string,
  dir: string,
): Record<string, unknown>[] {
  const fullDir = resolve(worktree, dir);
  if (!existsSync(fullDir)) return [];
  return readdirSync(fullDir)
    .filter((f) => f.endsWith(".v1.json"))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(
          readFileSync(resolve(fullDir, f), "utf8"),
        ) as Record<string, unknown>;
      } catch {
        return { _parseError: true, fileName: f };
      }
    });
}

function readResearchRecursive(
  w: string,
  dir: string,
): Record<string, unknown>[] {
  const full = resolve(w, dir);
  if (!existsSync(full)) return [];
  const results: Record<string, unknown>[] = [];
  for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const p = resolve(full, entry.name);
    if (entry.isDirectory()) {
      results.push(...readResearchRecursive(w, `${dir}/${entry.name}`));
    } else if (entry.name.endsWith(".v1.json")) {
      try {
        results.push(JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>);
      } catch {
        results.push({ _parseError: true, fileName: entry.name });
      }
    }
  }
  return results;
}

function writeTextFile(dir: string, rel: string, content: string): void {
  const abs = resolve(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// ─── Main Builder ──────────────────────────────────────────────────────

export function buildCodeReviewExport(
  options: BuildCodeReviewExportOptions,
): BuildCodeReviewExportResult {
  const {
    repoRoot: w,
    profile,
    includeUntracked = false,
    outputPath,
    onProgress,
    signal,
  } = options;

  if (signal?.aborted) throw new Error("code_review_export cancelled");

  const packetRoot = getPacketRoot(profile);
  const now = new Date().toISOString();
  let phase = "reading";
  const exportStarted = performance.now();
  const timingsMs: Record<string, number> = {};

  // ── Stage 1: Read structural data ──

  const adrDir = resolve(w, "docs/adr");
  const adrsJson = readJsonDir(w, "docs/adr");
  const adrsMarkdown = existsSync(adrDir)
    ? readdirSync(adrDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => ({
          name: f,
          content: readFileSync(resolve(adrDir, f), "utf8"),
        }))
    : [];

  const campaigns = readJsonDir(w, "docs/json/omp/campaigns");
  const missions = readJsonDir(w, "docs/json/omp/missions");
  const lanes = readJsonDir(w, "docs/json/omp/lanes");
  const tasks = readJsonDir(w, "docs/json/omp/tasks");
  const research = readResearchRecursive(w, "docs/json/omp/research").filter(
    (r) => r.type === "research_context_packet",
  );
  const memoryLinks = readResearchRecursive(w, "docs/json/omp/research").filter(
    (r) => r.type === "memory_link",
  );

  timingsMs.discover = Math.max(
    0,
    Math.round(performance.now() - exportStarted),
  );

  // ── Stage 2: Create staging directory ──

  const tmpDir = resolve(tmpdir(), `tribunus-review-${Date.now()}`);
  const reviewDir = resolve(tmpDir, packetRoot);
  const repoDir = resolve(reviewDir, "repo");
  const metaDir = resolve(reviewDir, "metadata");
  const boardDir = resolve(reviewDir, "board");
  const adrDestDir = resolve(reviewDir, "adr");
  const researchDestDir = resolve(reviewDir, "research");

  mkdirSync(metaDir, { recursive: true });
  mkdirSync(boardDir, { recursive: true });

  if (profile === "gemini_code_review") {
    writeTextFile(reviewDir, "GEMINI_REVIEW_GUIDE.md", [
      "# Gemini Code Review Guide",
      "",
      "This archive is a Gemini-friendly code review packet for Tribunus.",
      "",
      "Primary review targets:",
      "",
      "- .omp/tools public custom tools",
      "- .omp/tools/_lib OMP tool kernel",
      "- .omp/tools/_lib/store PGlite coordination store",
      "- .omp/tools/_lib/analytics DuckDB projection layer",
      "- .omp/tools/manifests tool manifests",
      "- .omp/tools/tests tests",
      "- .omp/mcp-manifest.v1.json MCP authority classification",
      "",
      "Secondary context:",
      "",
      "- packages/ source code",
      "- schemas/",
      "- docs/json current architecture artifacts",
      "- ADRs and docs",
      "- workflows and scripts",
      "",
      "Review priorities:",
      "",
      "- correctness",
      "- concurrency safety",
      "- path-locking",
      "- hash preconditions",
      "- receipt integrity",
      "- export completeness",
      "- OMP independence from Tribunus imports",
      "",
      "Gemini upload guidance:",
      "",
      `- one top-level folder: ${packetRoot}/`,
      `- target file count below ${GEMINI_MAX_FILE_COUNT}`,
      `- target zip size below ${formatBytes(GEMINI_MAX_ZIP_BYTES)}`,
      "",
    ].join("\n"));
  }

  // ── Stage 3: Git metadata ──

  let branch: string | undefined;
  let headSha: string | undefined;
  let isDirty = false;

  const branchResult = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], w);
  if (branchResult.ok) branch = branchResult.stdout.trim();

  const shaResult = gitExec(["rev-parse", "HEAD"], w);
  if (shaResult.ok) headSha = shaResult.stdout.trim();

  const statusResult = gitExec(["status", "--porcelain"], w);
  if (statusResult.ok && statusResult.stdout.trim().length > 0) {
    isDirty = true;
  }

  // Write git status
  const gitStatusResult = gitExec(["status"], w);
  writeTextFile(
    metaDir,
    "git-status.txt",
    gitStatusResult.ok ? gitStatusResult.stdout : gitStatusResult.stderr,
  );

  // Write git diff if dirty
  let diffPath: string | undefined;
  if (isDirty) {
    const diffResult = gitExec(["diff"], w);
    if (diffResult.ok && diffResult.stdout) {
      writeTextFile(metaDir, "git-diff.patch", diffResult.stdout);
      diffPath = "metadata/git-diff.patch";
    } else {
      // Try diff --cached for staged-only dirtiness
      const cachedResult = gitExec(["diff", "--cached"], w);
      if (cachedResult.ok && cachedResult.stdout) {
        writeTextFile(metaDir, "git-diff.patch", cachedResult.stdout);
        diffPath = "metadata/git-diff.patch";
      }
    }
  }

  // ── Stage 4: Collect file lists ──

  phase = "collecting";

  // Tracked files
  const gitArgs = includeUntracked
    ? ["ls-files", "--cached", "--others", "--exclude-standard"]
    : ["ls-files", "--cached"];

  const gitLsResult = gitExec(gitArgs, w);
  const discoveredTracked: string[] = gitLsResult.ok
    ? gitLsResult.stdout.trim().split("\n").filter(Boolean)
    : [];
  const allTracked = Array.from(
    new Set([
      ...discoveredTracked,
      ...REQUIRE_MISSING_FAIL.filter((path) => existsSync(resolve(w, path))),
    ]),
  );

  // Write tracked files list
  writeTextFile(metaDir, "tracked-files.txt", allTracked.sort().join("\n"));

  // ── Stage 5: Policy application ──

  phase = "applying_policy";

  const includedFiles: FileEntry[] = [];
  const excludedFiles: ExclusionEntry[] = [];
  const oversizedFiles: ExclusionEntry[] = [];
  const missingExpected: Array<{
    path: string;
    status: "missing" | "excluded" | "oversized";
    reason?: string;
  }> = [];
  const warnings: string[] = [];
  let importClosureSummary = {
    remapCount: 0,
    missingCount: 0,
    notIncludedCount: 0,
    externalCount: 0,
  };

  // Track required paths
  const requiredPathStatuses: Array<{
    path: string;
    status: "included" | "missing" | "excluded" | "oversized";
    reason?: string;
  }> = [];

  // Process all tracked files
  for (const relPath of allTracked) {
    if (signal?.aborted) throw new Error("code_review_export cancelled during file collection");

    const policy = shouldIncludePath(relPath, excludedFiles);
    if (!policy.include) {
      const src = resolve(w, relPath);
      let sizeBytes: number | undefined;
      try {
        if (existsSync(src)) {
          const st = statSync(src);
          if (st.isFile()) sizeBytes = st.size;
        }
      } catch {
        // skip
      }
      excludedFiles.push({
        path: relPath,
        reason: policy.reason,
        size_bytes: sizeBytes,
      });
      continue;
    }

    // Check size
    const src = resolve(w, relPath);
    let size = 0;
    try {
      if (existsSync(src)) {
        const st = statSync(src);
        if (st.isFile()) size = st.size;
      } else {
        excludedFiles.push({
          path: relPath,
          reason: "file not found on disk",
          size_bytes: 0,
        });
        continue;
      }
    } catch {
      excludedFiles.push({ path: relPath, reason: "stat failed", size_bytes: 0 });
      continue;
    }

    if (size > MAX_FILE_BYTES) {
      oversizedFiles.push({
        path: relPath,
        reason: `file exceeds ${formatBytes(MAX_FILE_BYTES)} limit`,
        size_bytes: size,
      });
      continue;
    }

    // Copy file
    const buf = readFileSync(src);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const destAbs = resolve(repoDir, relPath);
    mkdirSync(dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, buf);

    includedFiles.push({
      path: relPath,
      size_bytes: buf.length,
      sha256,
      category: "source",
    });
  }

  timingsMs.index = Math.max(0, Math.round(performance.now() - exportStarted));

  // ── Write metadata files ──

  phase = "writing_metadata";

  // Included files list
  const includedLines = includedFiles
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path} (${formatBytes(f.size_bytes)})`)
    .join("\n");
  writeTextFile(metaDir, "included-files.txt", includedLines || "(none)");

  // Excluded files list
  const excludedLines = excludedFiles
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(
      (f) =>
        `${f.path} — ${f.reason}${f.size_bytes !== undefined ? ` (${formatBytes(f.size_bytes)})` : ""}`,
    )
    .join("\n");
  writeTextFile(metaDir, "excluded-files.txt", excludedLines || "(none)");

  // Oversized files list
  const oversizedLines = oversizedFiles
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(
      (f) =>
        `${f.path} (${f.size_bytes !== undefined ? formatBytes(f.size_bytes) : "unknown"}) — ${f.reason}`,
    )
    .join("\n");
  writeTextFile(metaDir, "oversized-files.txt", oversizedLines || "(none)");

  // Policy export
  const policyExport = {
    include_extensions: Object.keys(INCLUDE_EXTENSIONS).sort(),
    include_filenames: Object.keys(INCLUDE_FILENAMES).sort(),
    include_filename_prefixes: INCLUDE_FILENAME_PREFIXES,
    include_dir_prefixes: INCLUDE_DIR_PREFIXES,
    include_dir_patterns: INCLUDE_DIR_PATTERNS.map((p) => ({
      prefix: p.prefix,
      ext_filter: p.extFilter ? Object.keys(p.extFilter).sort() : undefined,
      name_filter: p.nameFilter ? Object.keys(p.nameFilter).sort() : undefined,
    })),
    hard_exclude_segments: Object.keys(HARD_EXCLUDE_SEGMENTS).sort(),
    hard_exclude_prefixes: HARD_EXCLUDE_PREFIXES,
    hard_exclude_filenames: Object.keys(HARD_EXCLUDE_FILENAMES).sort(),
    hard_exclude_extensions: Object.keys(HARD_EXCLUDE_EXTENSIONS).sort(),
    max_file_bytes: MAX_FILE_BYTES,
    require_missing_fail: REQUIRE_MISSING_FAIL,
  };
  writeTextFile(metaDir, "export-policy.json", JSON.stringify(policyExport, null, 2));

  // Checksums
  const checksumLines =
    includedFiles
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => `${f.sha256}  repo/${f.path}`)
      .join("\n") + "\n";
  writeTextFile(metaDir, "checksums.sha256", checksumLines);

  // ── Stage: Copy structured data (ADR, board, research) ──

  phase = "copying_structured_data";

  // ADR JSONs
  if (existsSync(adrDir)) {
    mkdirSync(adrDestDir, { recursive: true });
    for (const f of readdirSync(adrDir).filter((f) => f.endsWith(".v1.json")).sort()) {
      const src = resolve(adrDir, f);
      const buf = readFileSync(src);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      writeFileSync(resolve(adrDestDir, f), buf);
      includedFiles.push({
        path: `adr/${f}`,
        size_bytes: buf.length,
        sha256,
        category: "adr",
      });
    }
  }

  // ADR markdowns
  if (existsSync(adrDir)) {
    for (const f of readdirSync(adrDir).filter((f) => f.endsWith(".md")).sort()) {
      const src = resolve(adrDir, f);
      const buf = readFileSync(src);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      writeFileSync(resolve(adrDestDir, f), buf);
      includedFiles.push({
        path: `adr/${f}`,
        size_bytes: buf.length,
        sha256,
        category: "adr",
      });
    }
  }

  // Board data
  for (const dir of ["campaigns", "missions", "lanes", "tasks"]) {
    const srcDir = resolve(w, "docs/json/omp", dir);
    if (existsSync(srcDir)) {
      const destDir2 = resolve(boardDir, dir);
      mkdirSync(destDir2, { recursive: true });
      for (const f of readdirSync(srcDir).filter((f) => f.endsWith(".v1.json")).sort()) {
        const src = resolve(srcDir, f);
        const buf = readFileSync(src);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        writeFileSync(resolve(destDir2, f), buf);
        includedFiles.push({
          path: `board/${dir}/${f}`,
          size_bytes: buf.length,
          sha256,
          category: "board",
        });
      }
    }
  }

  // Memory links
  const memoryLinksDir = resolve(w, "docs/json/omp/research/memory-links");
  if (existsSync(memoryLinksDir)) {
    const destDir2 = resolve(boardDir, "memory-links");
    mkdirSync(destDir2, { recursive: true });
    for (const f of readdirSync(memoryLinksDir).filter((f) => f.endsWith(".v1.json")).sort()) {
      const src = resolve(memoryLinksDir, f);
      const buf = readFileSync(src);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      writeFileSync(resolve(destDir2, f), buf);
      includedFiles.push({
        path: `board/memory-links/${f}`,
        size_bytes: buf.length,
        sha256,
        category: "board",
      });
    }
  }

  // Research packets (recursive)
  const researchSrcDir = resolve(w, "docs/json/omp/research");
  const collectResearch = (src: string, prefix: string) => {
    if (!existsSync(src)) return;
    for (const entry of readdirSync(src, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (signal?.aborted) throw new Error("code_review_export cancelled");
      const srcPath = resolve(src, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "memory-links") return; // skip — already handled above
        collectResearch(srcPath, rel);
      } else if (entry.name.endsWith(".v1.json")) {
        const buf = readFileSync(srcPath);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        const destRel = `research/${rel}`;
        writeFileSync(resolve(reviewDir, destRel), buf);
        includedFiles.push({
          path: destRel,
          size_bytes: buf.length,
          sha256,
          category: "research",
        });
      }
    }
  };
  mkdirSync(researchDestDir, { recursive: true });
  collectResearch(researchSrcDir, "");

  // ── Stage: Required path checking ──

  phase = "checking_required";

  for (const rp of REQUIRE_MISSING_FAIL) {
    const src = resolve(w, rp);
    if (!existsSync(src)) {
      missingExpected.push({ path: rp, status: "missing" });
      requiredPathStatuses.push({ path: rp, status: "missing" });
      warnings.push(`Required path not found: ${rp}`);
      continue;
    }

    const included = includedFiles.find((f) => f.path === rp);
    if (included) {
      requiredPathStatuses.push({ path: rp, status: "included" });
      continue;
    }

    const excluded = excludedFiles.find((f) => f.path === rp);
    if (excluded) {
      missingExpected.push({
        path: rp,
        status: "excluded",
        reason: excluded.reason,
      });
      requiredPathStatuses.push({
        path: rp,
        status: "excluded",
        reason: excluded.reason,
      });
      warnings.push(`Required path excluded by policy: ${rp} (${excluded.reason})`);
      continue;
    }

    const oversized = oversizedFiles.find((f) => f.path === rp);
    if (oversized) {
      missingExpected.push({
        path: rp,
        status: "oversized",
        reason: oversized.reason,
      });
      requiredPathStatuses.push({
        path: rp,
        status: "oversized",
        reason: oversized.reason,
      });
      warnings.push(`Required path oversized: ${rp}`);
      continue;
    }

    missingExpected.push({ path: rp, status: "missing" });
    requiredPathStatuses.push({ path: rp, status: "missing" });
    warnings.push(`Required path not collected: ${rp}`);
  }

  const isCi = process.env.OPENCODE_CI === "true";
  if (isCi && missingExpected.length > 0) {
    throw new Error(
      `CI mode: ${missingExpected.length} required path(s) missing or excluded:\n` +
        missingExpected
          .map(
            (m) =>
              `  ${m.path} (${m.status}${m.reason ? `: ${m.reason}` : ""})`,
          )
          .join("\n"),
    );
  }
  if (profile === "gemini_code_review" && missingExpected.length > 0) {
    throw new Error(
      `Gemini code-folder export requires all expected OMP paths to be present:\n` +
        missingExpected
          .map(
            (m) =>
              `  ${m.path} (${m.status}${m.reason ? `: ${m.reason}` : ""})`,
          )
          .join("\n"),
    );
  }

  // ── Stage: Import analysis ──

  const includedSourceFiles = includedFiles
    .map((f) => f.path)
    .filter((p) => sourceLikeExtensions(p));
  const includedSet = new Set(includedFiles.map((f) => f.path));
  const importFindings: ImportFinding[] = [];
  for (const relPath of includedSourceFiles) {
    const src = resolve(w, relPath);
    if (!existsSync(src)) continue;
    const content = readFileSync(src, "utf8");
    for (const specifier of collectRelativeImportSpecifiers(content)) {
      const candidates = resolveImportCandidates(relPath, specifier, w);
      const resolved = candidates.find((candidate) =>
        existsSync(resolve(w, candidate)),
      );
      const finding = classifyImportFinding({
        importer: relPath,
        specifier,
        repoRoot: w,
        resolved,
        includedSet,
      });
      if (finding) importFindings.push(finding);
    }
  }

  const remapLines = importFindings
    .filter((finding) => finding.kind === "remap")
    .map(
      (finding) =>
        `${finding.importer} -> ${finding.specifier} (TypeScript source remap to ${finding.resolved})`,
    )
    .sort();
  const missingLinesForImports = importFindings
    .filter((finding) => finding.kind === "missing")
    .map(
      (finding) =>
        `${finding.importer} -> ${finding.specifier} (missing target)`,
    )
    .sort();
  const notIncludedLines = importFindings
    .filter((finding) => finding.kind === "not_included")
    .map(
      (finding) =>
        `${finding.importer} -> ${finding.specifier} (resolved to ${finding.resolved} but not included)`,
    )
    .sort();
  const externalLines = importFindings
    .filter((finding) => finding.kind === "external")
    .map(
      (finding) =>
        `${finding.importer} -> ${finding.specifier} (external package import ignored)`,
    )
    .sort();

  importClosureSummary = {
    remapCount: remapLines.length,
    missingCount: missingLinesForImports.length,
    notIncludedCount: notIncludedLines.length,
    externalCount: externalLines.length,
  };

  if (
    importClosureSummary.missingCount + importClosureSummary.notIncludedCount >
    0
  ) {
    warnings.push(
      `Import closure found ${importClosureSummary.missingCount} missing target(s) and ${importClosureSummary.notIncludedCount} resolved-but-not-included import(s). See metadata/unresolved-imports.txt.`,
    );
  }

  const unresolvedLines = [
    "# Import Closure Findings",
    "",
    "## Summary",
    "",
    `- TypeScript source remaps: ${remapLines.length}`,
    `- Missing targets: ${missingLinesForImports.length}`,
    `- Resolved but not included: ${notIncludedLines.length}`,
    `- External imports ignored: ${externalLines.length}`,
    "",
    "## TypeScript Source Remaps",
    "",
    ...(remapLines.length > 0 ? remapLines : ["(none)"]),
    "",
    "## Missing Targets",
    "",
    ...(missingLinesForImports.length > 0 ? missingLinesForImports : ["(none)"]),
    "",
    "## Resolved But Not Included",
    "",
    ...(notIncludedLines.length > 0 ? notIncludedLines : ["(none)"]),
    "",
    "## External Imports Ignored",
    "",
    ...(externalLines.length > 0 ? externalLines : ["(none)"]),
    "",
  ].join("\n");
  writeTextFile(metaDir, "unresolved-imports.txt", unresolvedLines);

  const missingLines = missingExpected
    .map(
      (m) =>
        `${m.path} — ${m.status}${m.reason ? ` (${m.reason})` : ""}`,
    )
    .join("\n");
  writeTextFile(metaDir, "missing-expected-files.txt", missingLines || "(none)");

  // ── Stage: Build manifest ──

  phase = "writing_manifest";

  const isCiEnv = process.env.OPENCODE_CI === "true";

  const manifest: CodeReviewPacketManifestV1 = {
    schema: "omp.code_review_packet_manifest.v1",
    created_at: now,
    repo_root: w,
    git: {
      branch,
      head_sha: headSha,
      is_dirty: isDirty,
      status_path: "metadata/git-status.txt",
      diff_path: diffPath,
    },
    policy: {
      include_sets: [
        "extensions",
        "filenames",
        "filename_prefixes",
        "dir_prefixes",
        "dir_patterns",
        "always_include_required",
        "import_closure",
      ],
      exclude_sets: [
        "hard_exclude_segments",
        "hard_exclude_prefixes",
        "hard_exclude_filenames",
        "hard_exclude_extensions",
      ],
      max_file_bytes: MAX_FILE_BYTES,
      oversized_file_policy: "omit_with_manifest",
    },
    counts: {
      included_files: includedFiles.length,
      excluded_files: excludedFiles.length,
      oversized_files: oversizedFiles.length,
      missing_expected_files: missingExpected.length,
      unresolved_imports:
        importClosureSummary.remapCount +
        importClosureSummary.missingCount +
        importClosureSummary.notIncludedCount,
    },
    required_paths: requiredPathStatuses,
    files: includedFiles.sort((a, b) => a.path.localeCompare(b.path)),
    exclusions: [
      ...excludedFiles.map((e) => ({
        path: e.path,
        reason: e.reason,
        size_bytes: e.size_bytes,
      })),
      ...oversizedFiles.map((e) => ({
        path: e.path,
        reason: e.reason,
        size_bytes: e.size_bytes,
      })),
    ],
    warnings,
  };

  writeTextFile(
    reviewDir,
    "REVIEW_PACKET_MANIFEST.json",
    JSON.stringify(manifest, null, 2),
  );

  // ── Stage: Write warnings markdown ──

  phase = "writing_warnings";

  if (warnings.length > 0) {
    const warnMd = [
      "# Code Review Export Warnings",
      "",
      `Export created at: ${now}`,
      `Repository: ${basename(w)}`,
      "",
      "## Summary",
      "",
      `- ${missingExpected.length} required path(s) missing`,
      `- ${importClosureSummary.remapCount + importClosureSummary.missingCount + importClosureSummary.notIncludedCount} import-closure finding(s)`,
      `- ${warnings.length} total warning(s)`,
      "",
      "## Required Path Status",
      "",
      "| Path | Status | Reason |",
      "|------|--------|--------|",
      ...requiredPathStatuses.map(
        (r) => `| ${r.path} | ${r.status} | ${r.reason || ""} |`,
      ),
      "",
      "## Import Closure",
      "",
      `- TypeScript source remaps: ${importClosureSummary.remapCount}`,
      `- Missing targets: ${importClosureSummary.missingCount}`,
      `- Resolved but not included: ${importClosureSummary.notIncludedCount}`,
      `- External imports ignored: ${importClosureSummary.externalCount}`,
      "",
      "## Warnings",
      "",
      ...warnings.map((w) => `- ${w}`),
      "",
    ].join("\n");
    writeTextFile(reviewDir, "REVIEW_PACKET_WARNINGS.md", warnMd);
  } else {
    writeTextFile(
      reviewDir,
      "REVIEW_PACKET_WARNINGS.md",
      [
        "# Code Review Export Warnings",
        "",
        `Export created at: ${now}`,
        `Repository: ${basename(w)}`,
        "",
        "## Summary",
        "",
        `- ${missingExpected.length} required path(s) missing`,
        `- ${importClosureSummary.remapCount + importClosureSummary.missingCount + importClosureSummary.notIncludedCount} import-closure finding(s)`,
        `- 0 total warning(s)`,
        "",
        "## Import Closure",
        "",
        `- TypeScript source remaps: ${importClosureSummary.remapCount}`,
        `- Missing targets: ${importClosureSummary.missingCount}`,
        `- Resolved but not included: ${importClosureSummary.notIncludedCount}`,
        `- External imports ignored: ${importClosureSummary.externalCount}`,
        "",
        "No warnings.",
        "",
      ].join("\n"),
    );
  }

  // ── Stage: Write summary markdown ──

  phase = "writing_summary";

  const summaryMd = [
    "# Code Review Export Summary",
    "",
    `**Created:** ${now}`,
    `**Repository:** ${basename(w)}`,
    `**Branch:** ${branch || "(unknown)"}`,
    `**Commit:** ${headSha || "(unknown)"}`,
    `**Dirty:** ${isDirty ? "Yes" : "No"}`,
    "",
    "## Counts",
    "",
    "| Category | Count |",
    "|----------|-------|",
    `| Included files | ${includedFiles.length} |`,
    `| Excluded files | ${excludedFiles.length} |`,
    `| Oversized files | ${oversizedFiles.length} |`,
    `| Missing expected | ${missingExpected.length} |`,
    `| ADR JSONs | ${adrsJson.length} |`,
    `| ADR markdowns | ${adrsMarkdown.length} |`,
    `| Campaigns | ${campaigns.length} |`,
    `| Missions | ${missions.length} |`,
    `| Lanes | ${lanes.length} |`,
    `| Tasks | ${tasks.length} |`,
    `| Research packets | ${research.length} |`,
    `| Memory links | ${memoryLinks.length} |`,
    "",
    "## Git",
    "",
    `- Git status: ${gitStatusResult.ok ? "ok" : "failed"}`,
    `- Diff: ${diffPath ? "included" : "no diff"}`,
    `- Included untracked: ${includeUntracked}`,
    "",
    "## Policy",
    "",
    `- Max file size: ${formatBytes(MAX_FILE_BYTES)}`,
    `- Oversized file policy: omit_with_manifest`,
    `- CI mode: ${isCiEnv}`,
    "",
    warnings.length > 0
      ? `## Warnings\n\n${warnings.length} warning(s). See REVIEW_PACKET_WARNINGS.md for details.\n`
      : "",
  ].join("\n");
  writeTextFile(reviewDir, "REVIEW_PACKET_SUMMARY.md", summaryMd);

  // ── Stage: Write tree ──

  phase = "writing_tree";

  const allIncludedPaths = includedFiles.map((f) => f.path);
  const treeContent = buildTree(allIncludedPaths);
  writeTextFile(
    reviewDir,
    "REVIEW_PACKET_TREE.txt",
    `${packetRoot}/\n` + treeContent,
  );

  // ── Stage: Zip ──

  phase = "zipping";

  if (signal?.aborted) throw new Error("code_review_export cancelled before zip");

  const zipPath = outputPath ? resolve(outputPath) : resolve(w, getZipName(profile));
  const tmpZipPath = resolve(dirname(zipPath), `.${packetRoot}.${Date.now()}.zip.tmp`);

  const archive = createZipCliArchiveBackend();
  const zipResult = archive.zipDirectory({
    source_dir: reviewDir,
    archive_path: tmpZipPath,
    stage: "semantic_zip" as const,
  });

  // Atomically replace
  renameSync(tmpZipPath, zipPath);

  const zipSize = zipResult.size_bytes;

  if (profile === "gemini_code_review") {
    const geminiWarnings = validateGeminiBundle({
      zipPath,
      zipSize,
      includedFiles,
    });
    for (const warning of geminiWarnings) warnings.push(warning);
  }

  const zipSha256 = zipResult.sha256;
  timingsMs.complete = Math.max(
    0,
    Math.round(performance.now() - exportStarted),
  );

  return {
    includedFiles,
    warnings,
    exclusionEntries: excludedFiles,
    oversizedFiles,
    missingExpected,
    importFindings,
    zipSha256,
    zipPath,
    zipSize,
    gitBranch: branch,
    gitHeadSha: headSha,
    isDirty,
    gitDiffPath: diffPath,
    manifest,
    adrsJson,
    adrsMarkdown,
    campaigns,
    missions,
    lanes,
    tasks,
    research,
    memoryLinks,
    timingsMs,
  };
}
