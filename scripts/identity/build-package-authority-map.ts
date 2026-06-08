/**
 * Builds the package authority map from workspace package manifests.
 *
 * Walks workspace directories, reads each package.json, and produces:
 *   - A JSON authority map at artifacts/identity/source-cutover/package-authority-map.json
 *   - A human-readable summary at artifacts/identity/source-cutover/package-authority-map.txt
 *
 * Classification:
 *   TRIBUNUS_FIRST_PARTY    -- package owned by this project (workspace member)
 *   EXTERNAL_OPENCODE_DEPENDENCY  -- third-party dep whose name contains "opencode"
 *
 * Run: bun run scripts/identity/build-package-authority-map.ts
 */

import { join, dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const ROOT = import.meta.dirname ? join(import.meta.dirname, "..", "..") : process.cwd();
const OUT_DIR = join(ROOT, "artifacts", "identity", "source-cutover");
const OUT_JSON = join(OUT_DIR, "package-authority-map.json");
const OUT_SUMMARY = join(OUT_DIR, "package-authority-map.txt");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PackageManifest {
  name?: string;
  private?: boolean;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface AuthorityEntry {
  /** Current package name */
  currentName: string;
  /** Filesystem path relative to repo root */
  path: string;
  /** Authority classification */
  authority: "TRIBUNUS_FIRST_PARTY" | "EXTERNAL_OPENCODE_DEPENDENCY";
  /** Intended @tribunus/* name after cutover (for TRIBUNUS_FIRST_PARTY) */
  intendedName?: string;
  /** License string from package.json */
  license?: string;
  /** Whether this is a workspace:* reference vs external registry */
  isWorkspace: boolean;
  /** Whether we found the package.json on disk (for workspace entries that refer to non-existent dirs) */
  exists: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    if (!existsSync(path)) return null;
    const raw = Bun.file(path);
    return JSON.parse(await raw.text()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Map a package name to its intended @tribunus/* name.
 */
function mapToIntendedName(name: string | undefined): string | undefined {
  if (!name) return undefined;

  // @tribunus/sdk -> @tribunus/sdk
  if (name === "@tribunus/sdk") return "@tribunus/sdk";
  // @tribunus/plugin -> @tribunus/plugin
  if (name === "@tribunus/plugin") return "@tribunus/plugin";
  // @tribunus/core -> @tribunus/core
  if (name === "@tribunus/core") return "@tribunus/core";
  // opencode (bare) -> @tribunus/runtime
  if (name === "opencode") return "@tribunus/runtime";

  // Other @opencode-ai/* -> @tribunus/*
  if (name.startsWith("@opencode-ai/")) {
    const suffix = name.slice("@opencode-ai/".length);
    return `@tribunus/${suffix}`;
  }

  // Already @tribunus/* or neutral workspace package -> keep current name
  return name;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Read root package.json
  const rootPkg = await readJson(join(ROOT, "package.json"));
  if (!rootPkg) {
    console.error("ERROR: Could not read root package.json");
    process.exit(1);
  }

  // Expand workspace packages globs
  const workspaces = rootPkg.workspaces?.packages as string[] | undefined;
  if (!workspaces) {
    console.error("ERROR: No workspaces.packages found in root package.json");
    process.exit(1);
  }

  // Resolve workspace globs into actual directories
  // We support simple patterns: packages/* -> all dirs under packages/
  // packages/console/* -> all dirs under packages/console/
  // packages/stats/* -> all dirs under packages/stats/
  // packages/sdk/js -> specific dir
  // packages/slack -> specific dir
  const workspaceDirs: string[] = [];
  const seenPaths = new Set<string>();
  for (const pattern of workspaces) {
    if (pattern.endsWith("/*")) {
      // Glob-style: list subdirectories
      const baseDir = join(ROOT, pattern.slice(0, -2));
      try {
        const dirents = readdirSync(baseDir, { withFileTypes: true });
        for (const entry of dirents) {
          if (!entry.isDirectory()) continue;
          const fullPath = join(baseDir, entry.name);
          if (existsSync(join(fullPath, "package.json"))) {
            if (seenPaths.has(fullPath)) continue;
            seenPaths.add(fullPath);
            workspaceDirs.push(fullPath);
          }
        }
      } catch {
        // Directory doesn't exist, skip
      }
    } else {
      // Specific path
      const fullPath = join(ROOT, pattern);
      if (existsSync(join(fullPath, "package.json"))) {
        if (seenPaths.has(fullPath)) continue;
        seenPaths.add(fullPath);
        workspaceDirs.push(fullPath);
      }
    }
  }

  const entries: AuthorityEntry[] = [];

  // 1. Process all workspace packages (TRIBUNUS_FIRST_PARTY)
  for (const dir of workspaceDirs) {
    const pkgPath = join(dir, "package.json");
    const pkg = (await readJson(pkgPath)) as PackageManifest | null;
    if (!pkg) continue;

    const name = pkg.name;
    if (!name) continue;

    const relPath = dir.startsWith(ROOT) ? dir.slice(ROOT.length + 1) : dir;
    const intended = mapToIntendedName(name);

    entries.push({
      currentName: name,
      path: relPath,
      authority: "TRIBUNUS_FIRST_PARTY",
      intendedName: intended,
      license: pkg.license,
      isWorkspace: true,
      exists: true,
    });
  }

  // 2. Scan all workspace package.json files for external dependencies
  //    whose names contain "opencode" (EXTERNAL_OPENCODE_DEPENDENCY)
  const seenExternal = new Set<string>();

  for (const dir of workspaceDirs) {
    const pkgPath = join(dir, "package.json");
    const pkg = (await readJson(pkgPath)) as PackageManifest | null;
    if (!pkg) continue;

    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };

    for (const [depName, depVersion] of Object.entries(allDeps)) {
      // Must contain "opencode" somewhere in the name
      if (!depName.toLowerCase().includes("opencode")) continue;

      // Skip workspace:* references (already processed as TRIBUNUS_FIRST_PARTY)
      if (depVersion === "workspace:*") continue;
      // Skip packages that are workspace members
      const isWorkspaceMember = entries.some((e) => e.currentName === depName);
      if (isWorkspaceMember) continue;

      if (seenExternal.has(depName)) continue;
      seenExternal.add(depName);

      entries.push({
        currentName: depName,
        path: "", // external, no repo path
        authority: "EXTERNAL_OPENCODE_DEPENDENCY",
        license: undefined, // unknown for external deps
        isWorkspace: false,
        exists: false,
      });
    }
  }

  // 3. Sort entries: TRIBUNUS_FIRST_PARTY first (alphabetical by currentName), then external
  entries.sort((a, b) => {
    if (a.authority !== b.authority) {
      return a.authority === "TRIBUNUS_FIRST_PARTY" ? -1 : 1;
    }
    return a.currentName.localeCompare(b.currentName);
  });

  // 4. Write JSON output
  const jsonDir = dirname(OUT_JSON);
  if (!existsSync(jsonDir)) {
    await Bun.write(join(jsonDir, ".keep"), "");
  }

  const output = {
    metadata: {
      generatedAt: new Date().toISOString(),
      source: "scripts/identity/build-package-authority-map.ts",
      description: "Package authority map for Tribunus Source Identity Cutover",
      firstPartyCount: entries.filter((e) => e.authority === "TRIBUNUS_FIRST_PARTY").length,
      externalCount: entries.filter((e) => e.authority === "EXTERNAL_OPENCODE_DEPENDENCY").length,
    },
    entries,
  };

  await Bun.write(OUT_JSON, JSON.stringify(output, null, 2));

  // 5. Write human-readable summary
  const lines: string[] = [];
  lines.push("=".repeat(72));
  lines.push("  TRIBUNUS PACKAGE AUTHORITY MAP");
  lines.push("  Source Identity Cutover");
  lines.push(`  Generated: ${new Date().toISOString()}`);
  lines.push("=".repeat(72));
  lines.push("");

  lines.push(`TRIBUNUS_FIRST_PARTY (${output.metadata.firstPartyCount} packages)`);
  lines.push("-".repeat(72));
  lines.push("");
  for (const e of entries.filter((e) => e.authority === "TRIBUNUS_FIRST_PARTY")) {
    const existsMarker = e.exists ? "" : " [MISSING FROM DISK]";
    lines.push(`  ${e.currentName}`);
    lines.push(`    path:          ${e.path}`);
    lines.push(`    intended name: ${e.intendedName ?? "(unchanged)"}`);
    lines.push(`    license:       ${e.license ?? "(missing)"}`);
    lines.push(`    exists:        ${e.exists}${existsMarker}`);
    lines.push("");
  }

  lines.push(`EXTERNAL_OPENCODE_DEPENDENCY (${output.metadata.externalCount} packages)`);
  lines.push("-".repeat(72));
  lines.push("");
  for (const e of entries.filter((e) => e.authority === "EXTERNAL_OPENCODE_DEPENDENCY")) {
    lines.push(`  ${e.currentName}`);
    lines.push(`    isWorkspace:   ${e.isWorkspace}`);
    lines.push("");
  }

  lines.push("=".repeat(72));

  await Bun.write(OUT_SUMMARY, lines.join("\n"));

  console.log(`Wrote ${OUT_JSON}`);
  console.log(`Wrote ${OUT_SUMMARY}`);
  console.log(`  ${output.metadata.firstPartyCount} first-party packages`);
  console.log(`  ${output.metadata.externalCount} external opencode dependencies`);
}

await main();
