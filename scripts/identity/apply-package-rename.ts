#!/usr/bin/env bun
/**
 * Package Rename Applicator — executes package renames using literal search-and-replace.
 *
 * Reads the package-authority-map and migration-waves plan, then for a given wave:
 *   - Updates each package.json `name` field
 *   - Finds and replaces all import/reference patterns for the old name
 *   - Writes a mutation journal to artifacts/identity/source-cutover/
 *
 * Usage:
 *   bun run scripts/identity/apply-package-rename.ts \
 *     --wave <N> \
 *     --authority-map <path> \
 *     [--dry-run]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  dryRun: boolean;
  wave: number;
  authorityMap: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let dryRun = false;
  let wave = 0;
  let authorityMap = "";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--wave":
        wave = parseInt(args[++i], 10);
        if (isNaN(wave)) {
          console.error("ERROR: --wave requires a numeric argument");
          process.exit(1);
        }
        break;
      case "--authority-map":
        authorityMap = args[++i];
        break;
    }
  }

  if (!wave || !authorityMap) {
    console.error("Usage: apply-package-rename.ts --wave <N> --authority-map <path> [--dry-run]");
    process.exit(1);
  }

  return { dryRun, wave, authorityMap };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthorityMapPackage {
  currentName: string;
  currentPath: string;
  intendedName: string;
  intendedPath: string;
  ownership: string;
  isWorkspace: boolean;
  isPublished: boolean;
  license: string;
  repositoryOfRecord: string;
  migrationStrategy: string;
  upstreamOrigin?: string;
  compatibilityRequirements?: string;
  externalConsumers?: string[];
  removalCondition?: string;
}

interface AuthorityMapData {
  entries: AuthorityMapPackage[];
  version: string;
  generatedAt: string;
}

interface MigrationWave {
  wave: number;
  name: string;
  description: string;
  packages: string[];
  packageJsons: string[];
  importReferences: string[];
}

interface MigrationWavesPlan {
  waves: MigrationWave[];
  metadata: {
    generated: string;
    strategy: string;
  };
}

interface MutationEntry {
  filePath: string;
  sha256Before: string;
  sha256After: string;
  operation: "package_name" | "import_reference";
  oldPattern: string;
  newPattern: string;
  replacements: number;
  skipped?: boolean;
  skipReason?: string;
}

interface MutationJournal {
  wave: number;
  waveName: string;
  dryRun: boolean;
  executedAt: string;
  entries: MutationEntry[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");

function resolvePath(p: string): string {
  if (p.startsWith("/")) return p;
  return join(PROJECT_ROOT, p);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buf: string): string {
  return createHash("sha256").update(buf, "utf-8").digest("hex");
}

function shouldSkip(filePath: string): boolean {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts.includes("node_modules") || parts.includes("dist") || parts.includes(".git");
}

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".md", ".mdx",
  ".css", ".scss", ".less", ".html", ".svg", ".vue", ".svelte",
  ".txt", ".hbs", ".ejs", ".astro",
]);

function isTextFilePath(p: string): boolean {
  const dot = p.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(p.substring(dot));
}

// Collect all files recursively under a directory, skipping node_modules/dist/.git
function collectFiles(dir: string): string[] {
  const result: string[] = [];
  function walk(d: string) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      if (shouldSkip(full)) continue;
      try {
        readdirSync(full); // directory check via readdir; throws if not dir
        walk(full);
      } catch {
        result.push(full); // not a directory → file
      }
    }
  }
  walk(dir);
  return result;
}

// ---------------------------------------------------------------------------
// Read inputs
// ---------------------------------------------------------------------------

function readAuthorityMap(path: string): AuthorityMapData {
  const raw = readFileSync(resolvePath(path), "utf-8");
  return JSON.parse(raw) as AuthorityMapData;
}

function readMigrationWaves(): MigrationWavesPlan {
  const raw = readFileSync(
    join(PROJECT_ROOT, "artifacts", "identity", "source-cutover", "migration-waves.json"),
    "utf-8",
  );
  return JSON.parse(raw) as MigrationWavesPlan;
}

// ---------------------------------------------------------------------------
// Collect replacement patterns for a wave (sorted longest-first)
// ---------------------------------------------------------------------------

interface PatternReplacement {
  oldPattern: string;
  newPattern: string;
}

function collectReplacements(
  wave: MigrationWave,
  authorityMap: AuthorityMapData,
): PatternReplacement[] {
  const replacements: PatternReplacement[] = [];

  for (const pkgName of wave.packages) {
    const entry = authorityMap.entries.find(
      (p) => p.currentName === pkgName || p.intendedName === pkgName,
    );
    if (!entry) {
      console.warn(`  [WARN] Package "${pkgName}" not found in authority map — skipping`);
      continue;
    }
    if (entry.ownership !== "TRIBUNUS_FIRST_PARTY") {
      console.warn(`  [SKIP] "${pkgName}" is ${entry.ownership} — only TRIBUNUS_FIRST_PARTY renamed`);
      continue;
    }
    if (entry.currentName === entry.intendedName) {
      console.warn(`  [SKIP] "${pkgName}" already at intended name`);
      continue;
    }
    replacements.push({ oldPattern: entry.currentName, newPattern: entry.intendedName });
  }

  // Longest patterns first: avoid matching a prefix of a longer name
  replacements.sort((a, b) => b.oldPattern.length - a.oldPattern.length);
  return replacements;
}

// ---------------------------------------------------------------------------
// Apply all replacements to a string (single pass, longest-first)
// ---------------------------------------------------------------------------

function applyAllReplacements(
  content: string,
  replacements: PatternReplacement[],
): { result: string; totalCount: number } {
  let result = content;
  let totalCount = 0;

  for (const rep of replacements) {
    // Skip if the pattern is not present (fast path)
    if (!result.includes(rep.oldPattern)) continue;

    let count = 0;
    const oldLen = rep.oldPattern.length;

    const segments: string[] = [];
    let pos = 0;

    while (true) {
      const idx = result.indexOf(rep.oldPattern, pos);
      if (idx === -1) break;
      segments.push(result.slice(pos, idx));
      segments.push(rep.newPattern);
      pos = idx + oldLen;
      count++;
      if (count > 10_000) {
        console.warn(`    [WARN] Over 10,000 matches for "${rep.oldPattern}" — stopping`);
        break;
      }
    }

    if (count > 0) {
      segments.push(result.slice(pos));
      result = segments.join("");
      totalCount += count;
    }
  }

  return { result, totalCount };
}

// ---------------------------------------------------------------------------
// Phase 1: Update a package.json name field
// ---------------------------------------------------------------------------

function mutatePackageJson(
  pkgJsonPath: string,
  patterns: PatternReplacement[],
  dryRun: boolean,
): MutationEntry | null {
  const resolved = resolvePath(pkgJsonPath);
  if (!existsSync(resolved)) {
    console.warn(`  [SKIP] package.json not found: ${pkgJsonPath}`);
    return null;
  }

  const contentBefore = readFileSync(resolved, "utf-8");
  const pkg = JSON.parse(contentBefore);
  const currentName: string = pkg.name;

  const rep = patterns.find((p) => p.oldPattern === currentName);
  if (!rep) {
    return null;
  }

  const entry: MutationEntry = {
    filePath: relative(PROJECT_ROOT, resolved),
    sha256Before: sha256(contentBefore),
    sha256After: "",
    operation: "package_name",
    oldPattern: rep.oldPattern,
    newPattern: rep.newPattern,
    replacements: 1,
  };

  console.log(`  ${relative(PROJECT_ROOT, resolved)}: "${rep.oldPattern}" → "${rep.newPattern}"`);

  if (!dryRun) {
    pkg.name = rep.newPattern;
    const contentAfter = JSON.stringify(pkg, null, 2) + "\n";
    entry.sha256After = sha256(contentAfter);
    writeFileSync(resolved, contentAfter, "utf-8");
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Phase 2: Replace import references in a single source file
// ---------------------------------------------------------------------------

function mutateSourceFile(
  filePath: string,
  replacements: PatternReplacement[],
  dryRun: boolean,
): MutationEntry {
  const resolved = resolvePath(filePath);
  const rel = relative(PROJECT_ROOT, resolved);

  const contentBefore = readFileSync(resolved, "utf-8");

  // Quick skip: ignore files that don't contain any old pattern
  const hasAny = replacements.some((r) => contentBefore.includes(r.oldPattern));
  if (!hasAny) {
    return {
      filePath: rel,
      sha256Before: sha256(contentBefore),
      sha256After: sha256(contentBefore),
      operation: "import_reference",
      oldPattern: "",
      newPattern: "",
      replacements: 0,
      skipped: true,
      skipReason: "no matches",
    };
  }

  const { result, totalCount } = applyAllReplacements(contentBefore, replacements);

  const entry: MutationEntry = {
    filePath: rel,
    sha256Before: sha256(contentBefore),
    sha256After: sha256(result),
    operation: "import_reference",
    oldPattern: replacements.length > 0 ? replacements[0].oldPattern : "",
    newPattern: replacements.length > 0 ? replacements[0].newPattern : "",
    replacements: totalCount,
  };

  if (totalCount === 0) {
    return { ...entry, skipped: true, skipReason: "unexpected zero count" };
  }

  for (const rep of replacements) {
    let idx = 0;
    let cnt = 0;
    while (true) {
      idx = contentBefore.indexOf(rep.oldPattern, idx);
      if (idx === -1) break;
      cnt++;
      idx += rep.oldPattern.length;
    }
    if (cnt > 0) {
      console.log(`    "${rep.oldPattern}" → "${rep.newPattern}" (${cnt}x)`);
    }
  }

  if (!dryRun) {
    writeFileSync(resolved, result, "utf-8");
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Resolve reference paths to concrete files
// ---------------------------------------------------------------------------

function resolveReferenceFiles(refPaths: string[]): string[] {
  const files = new Set<string>();

  for (const ref of refPaths) {
    const resolved = resolvePath(ref);
    if (!existsSync(resolved)) {
      console.warn(`  [WARN] Path not found: ${ref}`);
      continue;
    }
    try {
      // Try reading as directory first; throws if it's a file
      readdirSync(resolved);
      // It's a directory — collect files
      const subFiles = collectFiles(resolved);
      for (const f of subFiles) {
        if (!shouldSkip(f) && isTextFilePath(f)) {
          files.add(f);
        }
      }
    } catch {
      // It's a file
      if (!shouldSkip(resolved) && isTextFilePath(resolved)) {
        files.add(resolved);
      }
    }
  }

  return [...files];
}

// ---------------------------------------------------------------------------
// Print summary
// ---------------------------------------------------------------------------

function printSummary(journal: MutationJournal): void {
  const totalReplacements = journal.entries.reduce((s, e) => s + e.replacements, 0);
  const totalFiles = journal.entries.length;
  const skippedFiles = journal.entries.filter((e) => e.skipped).length;

  console.log(`\n=== Summary ===`);
  console.log(`  Files processed:    ${totalFiles}`);
  console.log(`  Files with no-ops:  ${skippedFiles}`);
  console.log(`  Total replacements: ${totalReplacements}`);
  console.log(`  Mode:               ${journal.dryRun ? "DRY RUN — no files written" : "APPLIED"}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<never> {
  const { dryRun, wave: targetWave, authorityMap: authorityMapPath } = parseArgs();

  console.log(`\n=== Package Rename Applicator ===`);
  console.log(`  Wave:          ${targetWave}`);
  console.log(`  Authority Map: ${authorityMapPath}`);
  console.log(`  Mode:          ${dryRun ? "DRY RUN" : "APPLY"}\n`);

  // [1] Read authority map
  console.log("[1/4] Reading authority map...");
  const authorityMap = readAuthorityMap(authorityMapPath);
  console.log(`  ${authorityMap.entries.length} packages loaded from authority map`);

  // [2] Read migration waves plan
  console.log("[2/4] Reading migration waves plan...");
  const wavesPlan = readMigrationWaves();
  console.log(`  ${wavesPlan.waves.length} waves loaded`);

  const wave = wavesPlan.waves.find((w) => w.wave === targetWave);
  if (!wave) {
    console.error(`ERROR: Wave ${targetWave} not found in migration plan`);
    process.exit(1);
  }
  console.log(`  Using wave ${wave.wave}: "${wave.name}" — ${wave.description}`);

  // [3] Collect replacement patterns
  console.log("[3/4] Collecting replacement patterns...");
  const replacements = collectReplacements(wave, authorityMap);
  if (replacements.length === 0) {
    console.log("  No packages to rename in this wave.");
    printSummary({
      wave: targetWave,
      waveName: wave.name,
      dryRun,
      executedAt: new Date().toISOString(),
      entries: [],
    });
    process.exit(0);
  }
  console.log(`  ${replacements.length} package(s) to rename:`);
  for (const rep of replacements) {
    console.log(`    "${rep.oldPattern}" → "${rep.newPattern}"`);
  }

  // Build mutation journal
  const journal: MutationJournal = {
    wave: wave.wave,
    waveName: wave.name,
    dryRun,
    executedAt: new Date().toISOString(),
    entries: [],
  };

  // [4] Apply changes
  console.log("\n[4/4] Applying changes...");

  // Phase 1: package.json name updates
  console.log("  Phase 1: Package.json name fields");
  for (const pkgJson of wave.packageJsons) {
    const entry = mutatePackageJson(pkgJson, replacements, dryRun);
    if (entry) {
      journal.entries.push(entry);
      if (dryRun) {
        console.log(`    [DRY-RUN] would write`);
      }
    }
  }

  // Phase 2: Import reference replacements
  console.log("  Phase 2: Import/reference replacements");
  if (wave.importReferences.length === 0) {
    console.log("  No import reference paths specified for this wave.");
  } else {
    const refFiles = resolveReferenceFiles(wave.importReferences);
    console.log(`  Scanning ${refFiles.length} reference files...`);

    for (const filePath of refFiles) {
      const entry = mutateSourceFile(filePath, replacements, dryRun);
      if (!entry.skipped || (entry.skipped && entry.skipReason !== "no matches")) {
        const label = entry.skipped ? " [no-op]" : dryRun ? " [DRY-RUN]" : "";
        console.log(`  ${relative(PROJECT_ROOT, filePath)}${label}`);
      }
      journal.entries.push(entry);
    }
  }

  // Write mutation journal
  const journalDir = join(PROJECT_ROOT, "artifacts", "identity", "source-cutover");
  if (!existsSync(journalDir)) {
    mkdirSync(journalDir, { recursive: true });
  }

  const journalPath = join(journalDir, `mutation-journal-wave-${targetWave}.json`);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2), "utf-8");
  console.log(`\nMutation journal → ${relative(PROJECT_ROOT, journalPath)}`);

  printSummary(journal);

  if (dryRun) {
    process.exit(0);
  }

  process.exit(0);
}

await main();
