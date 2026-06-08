#!/usr/bin/env bun
/**
 * Identity Verifier — scans git-tracked files for legacy OpenCode references
 * and verifies the project's branding identity against the canonical manifest.
 *
 * Usage: bun run scripts/identity/verify-identity.ts
 *
 * Exit 0 on pass (no violations), 1 on any identity violation.
 * Writes:
 *   artifacts/identity/identity-inventory.before.json
 *   artifacts/identity/identity-inventory.before.summary.txt
 *   artifacts/identity/identity-verification.receipt.json
 *   artifacts/identity/identity-verification.report.txt
 *
 * Replaces scripts/check-branding.sh — run from repo root.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ARTIFACTS_DIR = "artifacts/identity";
const OUTPUT_JSON = join(ARTIFACTS_DIR, "identity-inventory.before.json");
const OUTPUT_SUMMARY = join(ARTIFACTS_DIR, "identity-inventory.before.summary.txt");
const RECEIPT_JSON = join(ARTIFACTS_DIR, "identity-verification.receipt.json");
const REPORT_TXT = join(ARTIFACTS_DIR, "identity-verification.report.txt");

const IDENTITY_MANIFEST_PATH = "schemas/identity/tribunus-identity.v1.json";
const REGISTRY_PATH = "schemas/identity/legacy-reference-registry.v1.json";

// ---------------------------------------------------------------------------
// Identity manifest types
// ---------------------------------------------------------------------------

interface IdentityManifest {
  canonicalProductName: string;
  canonicalRepository: string;
  canonicalDomain: string;
  canonicalExecutable: string;
  canonicalCliInvocation: string;
  canonicalProjectDir: string;
  canonicalConfigFile: string;
  canonicalEnvPrefix: string;
  canonicalProtocolScheme: string;
  canonicalHttpHeaderPrefix: string;
  canonicalPackageScope: string;
  desktopProductName: string;
  desktopBundleId: string;
  desktopAppSupportDir: string;
  displayContact: string;
  securityContact: string;
  supportUrl: string;
  docsRoot: string;
  updateEndpoint: string;
  deepLinkScheme: string;
  userAgentPrefix: string;
  artifactPrefix: string;
  telemetryNamespace: string;
  releaseNamingPattern: string;
  version: string;
}

// ---------------------------------------------------------------------------
// Legacy reference registry types
// ---------------------------------------------------------------------------

type Classification =
  | "UPSTREAM_ATTRIBUTION_PERMANENT"
  | "EXTERNAL_UPSTREAM_DEPENDENCY"
  | "LEGACY_READ_COMPATIBILITY"
  | "LEGACY_DATA_MIGRATION"
  | "COMPATIBILITY_TEST_REFERENCE"
  | "HISTORICAL_FIXTURE"
  | "REMOVE_BEFORE_ALPHA"
  | "FORBIDDEN_ACTIVE_IDENTITY";

interface RegistryEntry {
  path: string;
  pattern: string;
  classification: Classification;
  subsystem: string;
  reason: string;
  permanent: boolean;
  replacementIdentity: string;
  removalGate?: string;
}

interface LegacyRegistry {
  version: string;
  generatedAt: string;
  entries: RegistryEntry[];
}

// ---------------------------------------------------------------------------
// Scanner types
// ---------------------------------------------------------------------------

interface Occurrence {
  file: string;
  line?: number;
  matched: string;
  contextHash: string;
  category: string;
}

interface ScanResult {
  scannedFiles: number;
  occurrences: Occurrence[];
  summary: {
    totalOccurrences: number;
    filesWithOccurrences: number;
    mixedIdentityLines: number;
    pathOccurrences: number;
  };
}

// ---------------------------------------------------------------------------
// Verification receipt types
// ---------------------------------------------------------------------------

interface VerificationReceipt {
  commitSha: string;
  identityManifestVersion: string;
  filesScanned: number;
  occurrencesByClassification: Record<string, number>;
  permanentExceptions: number;
  temporaryExceptions: number;
  unresolvedOccurrences: number;
  staleExceptions: number;
  verificationDurationMs: number;
  finalVerdict: "PASS" | "FAIL";
  failures: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Text extensions we consider scannable.
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".css",
  ".html",
  ".astro",
  ".nix",
  ".sh",
  ".xml",
  ".plist",
  ".entitlements",
  ".cfg",
  ".conf",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".env.example",
]);

// Legacy patterns to search for in file contents (case-insensitive).
const CONTENT_PATTERNS = [
  /opencode/gi,
  /@opencode-ai/gi,
  /\.opencode/gi,
  /opencode\.ai/gi,
  /github\.com\/sst\/opencode/gi,
  /github\.com\/anomalyco\/opencode/gi,
];

// Directories / patterns to entirely skip (relative paths after git-root prefix removal).
const SKIP_DIRS = [
  "node_modules",
  ".git",
  "schemas/generated",
  "dist",
  "ts-dist",
];

// Legacy path keywords (lowercase) — matches against whole path.
const LEGACY_PATH_KEYWORDS = ["opencode"];

// User-facing files that MUST NOT contain unauthorized "opencode" branding.
const USER_FACING_FILES: string[] = [
  "README.md",
  "packages/app/index.html",
  "packages/app/src/components/windows-app-menu.tsx",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function isTextFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = filePath.slice(dot).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function shouldSkip(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  for (const dir of SKIP_DIRS) {
    if (lower.startsWith(dir) || lower.includes(`/${dir}/`) || lower.includes(`/${dir}`)) {
      return true;
    }
  }
  return false;
}

function classifyMatch(matched: string): string {
  const m = matched.toLowerCase();
  if (m.includes("github.com/anomalyco/opencode")) return "anomalyco-opencode-link";
  if (m.includes("github.com/sst/opencode")) return "sst-opencode-link";
  if (m.includes("@opencode-ai")) return "opencode-ai-npm-scope";
  if (m.includes("opencode.ai")) return "opencode-ai-url";
  if (m.startsWith(".")) return "opencode-fs-path";
  if (m.startsWith("@")) return "opencode-npm-scope";
  if (/^opencode$/i.test(m.trim())) return "package-name";
  return "opencode-text";
}

function sha256(buf: string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function quote(s: string): string {
  return `"${s}"`;
}

// ---------------------------------------------------------------------------
// Read identity manifest
// ---------------------------------------------------------------------------

function readIdentityManifest(path: string): IdentityManifest | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as IdentityManifest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read legacy reference registry
// ---------------------------------------------------------------------------

function readRegistry(path: string): LegacyRegistry | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as LegacyRegistry;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Matching a registry entry to an occurrence
// ---------------------------------------------------------------------------

function entryMatchesOccurrence(entry: RegistryEntry, occ: Occurrence): boolean {
  const lowerPattern = entry.pattern.toLowerCase();
  const lowerMatched = occ.matched.toLowerCase();
  const lowerFile = occ.file.toLowerCase();

  // Pattern must match in either the file path or the matched text
  if (lowerFile.includes(lowerPattern)) return true;
  if (lowerMatched.includes(lowerPattern)) return true;

  // Also check the line content if available
  if (occ.line && lowerFile === entry.path) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Scan files
// ---------------------------------------------------------------------------

async function scanFiles(): Promise<ScanResult> {
  const proc = Bun.spawnSync(["git", "ls-files"], {
    cwd: resolve("."),
  });
  if (proc.exitCode !== 0) {
    console.error("FATAL: git ls-files failed (exit %d): %s", proc.exitCode, proc.stderr.toString());
    process.exit(1);
  }

  const allFiles = proc.stdout
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const occurrences: Occurrence[] = [];
  let scannedFiles = 0;
  const filesWithOccurrencesSet = new Set<string>();
  let mixedIdentityLines = 0;

  for (const file of allFiles) {
    if (shouldSkip(file)) continue;

    const pathLower = file.toLowerCase();
    for (const kw of LEGACY_PATH_KEYWORDS) {
      if (pathLower.includes(kw)) {
        occurrences.push({
          file,
          matched: file,
          contextHash: contextHash(file),
          category: "path-name",
        });
      }
    }

    // Content-based scanning (text files only)
    if (!isTextFile(file)) continue;

    scannedFiles++;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      // binary or unreadable — skip
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of CONTENT_PATTERNS) {
        let match: RegExpExecArray | null;
        pattern.lastIndex = 0;
        const localPattern = new RegExp(pattern.source, pattern.flags);
        while ((match = localPattern.exec(line)) !== null) {
          const matched = match[0];
          const trimmed = line.trim();

          occurrences.push({
            file,
            line: i + 1,
            matched,
            contextHash: contextHash(trimmed),
            category: classifyMatch(matched),
          });

          // Mixed-identity: both "tribunus" and "opencode" on same line
          if (/tribunus/i.test(trimmed) && /opencode/i.test(trimmed)) {
            mixedIdentityLines++;
          }
        }
      }
    }

    if (occurrences.some((o) => o.file === file)) {
      filesWithOccurrencesSet.add(file);
    }
  }

  const pathOccurrences = occurrences.filter((o) => o.category === "path-name").length;

  return {
    scannedFiles,
    occurrences,
    summary: {
      totalOccurrences: occurrences.length,
      filesWithOccurrences: filesWithOccurrencesSet.size,
      mixedIdentityLines,
      pathOccurrences,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<never> {
  const startTime = Date.now();
  const failures: string[] = [];

  // -- 0. Ensure artifacts directory exists ---------------------------------
  if (!existsSync(ARTIFACTS_DIR)) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  // -- 1. Read the canonical identity manifest -----------------------------
  const identityManifest = readIdentityManifest(IDENTITY_MANIFEST_PATH);
  if (!identityManifest) {
    failures.push(`Identity manifest not found at ${IDENTITY_MANIFEST_PATH}`);
  }

  // -- 2. Read the legacy reference registry --------------------------------
  const registry = readRegistry(REGISTRY_PATH);
  const registryEntries = registry?.entries ?? [];

  // Build a classification lookup: pattern -> classification
  const classificationByPattern = new Map<string, Classification>();
  const entryByPattern = new Map<string, RegistryEntry>();
  for (const entry of registryEntries) {
    const key = entry.pattern.toLowerCase();
    classificationByPattern.set(key, entry.classification);
    entryByPattern.set(key, entry);
  }

  // -- 3. Scan files --------------------------------------------------------
  console.log("=== Tribunus Identity Verification ===");
  console.log("");

  const result = await scanFiles();

  // Write scan outputs (backward compat with existing consumption)
  const jsonPath = resolve(OUTPUT_JSON);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2) + "\n");

  // -- 4. Classify each occurrence -----------------------------------------
  const occurrencesByClassification = new Map<string, number>();
  const permanentExceptions: Occurrence[] = [];
  const temporaryExceptions: Occurrence[] = [];
  const unresolvedOccurrences: Occurrence[] = [];

  for (const occ of result.occurrences) {
    // Try to classify against registry
    let foundClassification: string | null = null;
    let matchedEntry: RegistryEntry | null = null;

    for (const entry of registryEntries) {
      if (entryMatchesOccurrence(entry, occ)) {
        foundClassification = entry.classification;
        matchedEntry = entry;
        break;
      }
    }

    if (foundClassification) {
      occurrencesByClassification.set(
        foundClassification,
        (occurrencesByClassification.get(foundClassification) ?? 0) + 1,
      );
      if (matchedEntry?.permanent) {
        permanentExceptions.push(occ);
      } else {
        temporaryExceptions.push(occ);
      }
    } else {
      // Not in registry — unresolved
      unresolvedOccurrences.push(occ);
      occurrencesByClassification.set(
        "UNRESOLVED",
        (occurrencesByClassification.get("UNRESOLVED") ?? 0) + 1,
      );
    }
  }

  // Also track the raw scanner categories
  const catCount = new Map<string, number>();
  for (const occ of result.occurrences) {
    catCount.set(occ.category, (catCount.get(occ.category) ?? 0) + 1);
  }

  // -- 5. Detect STALE registry entries (registered but not found) ---------
  const staleEntries: RegistryEntry[] = [];
  const allOccurrencePatterns = new Set(
    result.occurrences.map((o) => o.matched.toLowerCase()),
  );
  const allOccurrenceFiles = new Set(result.occurrences.map((o) => o.file.toLowerCase()));

  for (const entry of registryEntries) {
    const lowerPattern = entry.pattern.toLowerCase();
    const patternFound = result.occurrences.some(
      (o) =>
        o.matched.toLowerCase().includes(lowerPattern) ||
        o.file.toLowerCase().includes(lowerPattern) ||
        entry.path === o.file,
    );
    if (!patternFound) {
      staleEntries.push(entry);
    }
  }

  // -- 6. V E R I F I C A T I O N   C H E C K S ---------------------------

  // 6a. Unauthorized legacy references (not in any registry category)
  if (unresolvedOccurrences.length > 0) {
    failures.push(
      `Found ${unresolvedOccurrences.length} unauthorized legacy reference(s) not in legacy-reference-registry`,
    );
  }

  // 6b. Stale registry entries (registered but not found in scan)
  if (staleEntries.length > 0) {
    failures.push(
      `Found ${staleEntries.length} stale registry entr(ies) with no matching code reference`,
    );
  }

  // 6c. Expired temporary entries (removal gate reached)
  const expiredEntries: RegistryEntry[] = [];
  for (const entry of registryEntries) {
    if (!entry.permanent && entry.removalGate) {
      // Simple heuristic: if removalGate mentions a version or date, we flag it.
      // This is a placeholder — actual gate-checking logic depends on the
      // format of removalGate values. For now, any non-permanent entry with
      // a removalGate is potentially expired if the gate text suggests it
      // should have been resolved already.
      const gate = entry.removalGate.toLowerCase();
      if (
        gate.includes("before public alpha") ||
        gate.includes("before v1") ||
        gate.includes("before 1.0") ||
        gate.includes("by ") ||
        gate.startsWith("remove ")
      ) {
        expiredEntries.push(entry);
      }
    }
  }
  if (expiredEntries.length > 0) {
    failures.push(
      `Found ${expiredEntries.length} expired temporary exemption(s) with removal gates: ${expiredEntries.map((e) => `"${e.pattern}" (${e.removalGate})`).join(", ")}`,
    );
  }

  // 6d. Path-based exemptions matching more files than expected
  // (checked via registry entries that have path patterns — if a file path
  // matching a registry path appears more times than a reasonable threshold,
  // it's flagged.)
  const pathOccurrenceCount = new Map<string, number>();
  for (const occ of result.occurrences) {
    if (occ.category === "path-name") {
      pathOccurrenceCount.set(occ.file, (pathOccurrenceCount.get(occ.file) ?? 0) + 1);
    }
  }
  for (const [file, count] of pathOccurrenceCount) {
    if (count > 1) {
      // Multiple path hits on same file — could indicate more references than expected
      const registriesForFile = registryEntries.filter(
        (e) => e.path && file.toLowerCase().includes(e.path.toLowerCase()),
      );
      if (registriesForFile.length > 0) {
        const expectedCount = registriesForFile.length;
        if (count > expectedCount) {
          failures.push(
            `Path-based exemption for ${file} matches ${count} occurrence(s), expected ~${expectedCount}`,
          );
        }
      }
    }
  }

  // 6e. Internal workspace package uses upstream namespace (@opencode-ai)
  if (identityManifest) {
    const internalPackages = ["packages/opencode/package.json", "packages/app/package.json"];
    for (const pkgPath of internalPackages) {
      try {
        if (existsSync(pkgPath)) {
          const pkgRaw = readFileSync(pkgPath, "utf-8");
          const pkg = JSON.parse(pkgRaw);
          if (pkg.name && pkg.name.startsWith("@opencode-ai")) {
            failures.push(
              `Internal workspace package ${pkgPath} uses upstream namespace "${pkg.name}" instead of "${identityManifest.canonicalPackageScope}"`,
            );
          }
        }
      } catch {
        // skip unreadable
      }
    }
  }

  // 6f. Canonical manifest and package metadata disagree
  if (identityManifest) {
    try {
      if (existsSync("package.json")) {
        const rootPkg = JSON.parse(readFileSync("package.json", "utf-8"));
        const rootName = (rootPkg.name as string) ?? "";
        const rootDesc = (rootPkg.description as string) ?? "";
        if (!rootName.toLowerCase().includes(identityManifest.canonicalProductName.toLowerCase())) {
          failures.push(
            `Root package.json name "${rootName}" does not reference canonical product name "${identityManifest.canonicalProductName}"`,
          );
        }
      }
    } catch {
      // skip
    }
  }

  // 6g. Security/contribution/support links use non-Tribunus domains
  if (identityManifest) {
    const expectedDomain = identityManifest.canonicalDomain;
    const checks: Array<{ label: string; value: string }> = [
      { label: "securityContact", value: identityManifest.securityContact },
      { label: "supportUrl", value: identityManifest.supportUrl },
    ];
    for (const check of checks) {
      if (check.value && !check.value.includes(expectedDomain)) {
        failures.push(
          `${check.label} "${check.value}" does not use canonical domain ${expectedDomain}`,
        );
      }
    }
  }

  // 6h. Canonical Tribunus config points at OpenCode schema
  try {
    const configPath = identityManifest?.canonicalConfigFile ?? "tribunus.jsonc";
    if (existsSync(configPath)) {
      const configRaw = readFileSync(configPath, "utf-8");
      if (configRaw.includes("opencode")) {
        // Check if the $schema references an opencode domain
        const schemaMatch = configRaw.match(/"\$schema"\s*:\s*"([^"]+)"/);
        if (schemaMatch && schemaMatch[1].includes("opencode")) {
          failures.push(
            `Canonical config file ${configPath} $schema points at OpenCode domain: ${schemaMatch[1]}`,
          );
        }
      }
    }
  } catch {
    // skip
  }

  // 6i. Active files under .opencode/ beyond compatibility boundary
  try {
    if (existsSync(".opencode")) {
      // The compatibility boundary allows .opencode/agent/css.md and similar
      // agent-config files. Any file beyond this is flagged.
      const opencodeEntries = readdirRecursive(".opencode");
      const allowedPrefixes = ["agent/css.md"];
      for (const entry of opencodeEntries) {
        if (!allowedPrefixes.some((a) => entry.startsWith(a))) {
          failures.push(
            `File "${entry}" under .opencode/ is beyond the compatibility boundary`,
          );
        }
      }
    }
  } catch {
    // skip
  }

  // -- 7. Write scan summary (backward compat) -----------------------------
  const summaryLines: string[] = [];
  summaryLines.push("=== Identity Inventory Summary ===");
  summaryLines.push(`Scanned files:                 ${result.scannedFiles}`);
  summaryLines.push(`Total occurrences:             ${result.summary.totalOccurrences}`);
  summaryLines.push(`Files with occurrences:        ${result.summary.filesWithOccurrences}`);
  summaryLines.push(`Mixed-identity lines:          ${result.summary.mixedIdentityLines}`);
  summaryLines.push(`Path-based occurrences:        ${result.summary.pathOccurrences}`);
  summaryLines.push("");
  summaryLines.push("--- Occurrences by file ---");
  const byFile = new Map<string, Occurrence[]>();
  for (const occ of result.occurrences) {
    if (!byFile.has(occ.file)) byFile.set(occ.file, []);
    byFile.get(occ.file)!.push(occ);
  }
  for (const [file, occs] of byFile) {
    const contentHits = occs.filter((o) => o.category !== "path-name").length;
    const pathHits = occs.filter((o) => o.category === "path-name").length;
    const parts: string[] = [];
    if (contentHits > 0) parts.push(`${contentHits} content`);
    if (pathHits > 0) parts.push(`${pathHits} path`);
    summaryLines.push(`  ${file}  [${parts.join(", ")}]`);
  }
  summaryLines.push("");
  summaryLines.push("--- Categories ---");
  for (const [cat, count] of [...catCount.entries()].sort((a, b) => b[1] - a[1])) {
    summaryLines.push(`  ${cat}: ${count}`);
  }

  const summaryPath = resolve(OUTPUT_SUMMARY);
  writeFileSync(summaryPath, summaryLines.join("\n") + "\n");
  console.log(summaryLines.join("\n"));

  // -- 8. Write verification receipt ---------------------------------------
  const commitSha = getGitCommitSha();
  const verificationDurationMs = Date.now() - startTime;
  const finalVerdict = failures.length === 0 ? "PASS" : "FAIL";

  const receipt: VerificationReceipt = {
    commitSha,
    identityManifestVersion: identityManifest?.version ?? "unknown",
    filesScanned: result.scannedFiles,
    occurrencesByClassification: Object.fromEntries(occurrencesByClassification),
    permanentExceptions: permanentExceptions.length,
    temporaryExceptions: temporaryExceptions.length,
    unresolvedOccurrences: unresolvedOccurrences.length,
    staleExceptions: staleEntries.length,
    verificationDurationMs,
    finalVerdict,
    failures,
  };

  writeFileSync(
    resolve(RECEIPT_JSON),
    JSON.stringify(receipt, null, 2) + "\n",
  );

  // -- 9. Write human-readable report --------------------------------------
  const reportLines: string[] = [];
  reportLines.push("=== Tribunus Identity Verification Report ===");
  reportLines.push(`Generated:       ${new Date().toISOString()}`);
  reportLines.push(`Commit:          ${commitSha}`);
  reportLines.push(`Identity Version: ${identityManifest?.version ?? "unknown"}`);
  reportLines.push(`Verdict:         ${finalVerdict}`);
  reportLines.push("");
  reportLines.push("--- Scan Statistics ---");
  reportLines.push(`  Files scanned:             ${result.scannedFiles}`);
  reportLines.push(`  Total occurrences:         ${result.summary.totalOccurrences}`);
  reportLines.push(`  Files with occurrences:    ${result.summary.filesWithOccurrences}`);
  reportLines.push(`  Mixed-identity lines:      ${result.summary.mixedIdentityLines}`);
  reportLines.push("");
  reportLines.push("--- Occurrence Classification ---");
  for (const [cls, count] of [...occurrencesByClassification.entries()].sort((a, b) => b[1] - a[1])) {
    reportLines.push(`  ${cls}: ${count}`);
  }
  reportLines.push("");
  reportLines.push("--- Registry Status ---");
  reportLines.push(`  Permanent exceptions:        ${permanentExceptions.length}`);
  reportLines.push(`  Temporary exceptions:        ${temporaryExceptions.length}`);
  reportLines.push(`  Unresolved occurrences:      ${unresolvedOccurrences.length}`);
  reportLines.push(`  Stale registry entries:      ${staleEntries.length}`);
  reportLines.push("");

  if (unresolvedOccurrences.length > 0) {
    reportLines.push("--- Unresolved Occurrences (Unauthorized) ---");
    for (const occ of unresolvedOccurrences.slice(0, 50)) {
      const loc = occ.line ? `${occ.file}:${occ.line}` : occ.file;
      reportLines.push(`  ${loc}  matched="${occ.matched}"`);
    }
    if (unresolvedOccurrences.length > 50) {
      reportLines.push(`  ... and ${unresolvedOccurrences.length - 50} more`);
    }
    reportLines.push("");
  }

  if (staleEntries.length > 0) {
    reportLines.push("--- Stale Registry Entries ---");
    for (const entry of staleEntries) {
      reportLines.push(`  ${entry.path}  pattern="${entry.pattern}"  classification=${entry.classification}`);
    }
    reportLines.push("");
  }

  if (failures.length > 0) {
    reportLines.push("--- Failure Reasons ---");
    for (const f of failures) {
      reportLines.push(`  FAIL: ${f}`);
    }
    reportLines.push("");
  }

  reportLines.push("--- Verification Artifacts ---");
  reportLines.push(`  Scan JSON:      ${jsonPath}`);
  reportLines.push(`  Scan Summary:   ${summaryPath}`);
  reportLines.push(`  Receipt:        ${resolve(RECEIPT_JSON)}`);
  reportLines.push(`  Report:         ${resolve(REPORT_TXT)}`);

  const reportText = reportLines.join("\n") + "\n";
  writeFileSync(resolve(REPORT_TXT), reportText);

  // Print to stdout
  console.log("");
  console.log(reportText);

  process.exit(finalVerdict === "PASS" ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function getGitCommitSha(): string {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: resolve("."),
    });
    if (proc.exitCode === 0) {
      return proc.stdout.toString().trim();
    }
  } catch {
    // fall through
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function readdirRecursive(dir: string): string[] {
  const result: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = full.startsWith(dir) ? full.slice(dir.length + 1) : full;
      if (entry.isDirectory()) {
        result.push(...readdirRecursive(full).map((f) => join(rel, f)));
      } else {
        result.push(rel);
      }
    }
  } catch {
    // skip unreadable
  }
  return result;
}

await main();
