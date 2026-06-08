#!/usr/bin/env bun
/**
 * Source Identity Cutover Plan Generator
 *
 * Reads the package authority map and workspace dependency graph, then
 * produces a staged migration plan organized into dependency-topological waves.
 *
 * Usage: bun run scripts/identity/plan-source-cutover.ts
 *
 * Input:
 *   artifacts/identity/source-cutover/package-authority-map.json
 *   All workspace package.json files (read at runtime)
 *
 * Output:
 *   artifacts/identity/source-cutover/migration-waves.json  — structured plan
 *   artifacts/identity/source-cutover/plan.md               — human-readable plan
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MAP_PATH = "artifacts/identity/source-cutover/package-authority-map.json";
const WAVES_JSON = "artifacts/identity/source-cutover/migration-waves.json";
const PLAN_MD = "artifacts/identity/source-cutover/plan.md";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Authority = "TRIBUNUS_FIRST_PARTY" | "EXTERNAL_OPENCODE_DEPENDENCY";

interface AuthorityEntry {
  currentName: string;
  path: string;
  authority: Authority;
  intendedName: string;
  license?: string;
  isWorkspace: boolean;
  exists: boolean;
}

interface AuthorityMap {
  metadata: {
    generatedAt: string;
    source: string;
    description: string;
    firstPartyCount: number;
    externalCount: number;
  };
  entries: AuthorityEntry[];
}

interface WorkspaceDep {
  name: string;
  dir: string;
  npmName: string;
  /** Workspace dependencies (production deps) */
  workspaceDeps: string[];
  /** Workspace devDependencies (excluded from topological sort) */
  workspaceDevDeps: string[];
}

interface WavePackage {
  currentName: string;
  intendedName: string;
  path: string;
  /** Whether the directory needs renaming */
  renameDirectory: boolean;
  /** Target directory when renamed */
  targetPath: string;
  /** Workspace production deps (npm names) */
  dependsOn: string[];
  /** All consumers in the workspace that reference this package */
  importReferences: WorkspaceRef[];
}

interface WorkspaceRef {
  consumer: string;
  consumerPath: string;
  depType: "dependencies" | "devDependencies";
}

interface MigrationWave {
  wave: number;
  label: string;
  description: string;
  packages: WavePackage[];
}

interface PlanOutput {
  waves: MigrationWave[];
  /** Production dep graph (npm names → list of workspace dep npm names) */
  graph: Record<string, string[]>;
  /** Reverse production dep graph (npm name → list of workspace consumers) */
  reverseGraph: Record<string, string[]>;
  summary: {
    totalFirstParty: number;
    totalRenamed: number;
    totalWaves: number;
    directoryRenames: string[];
  };
}

// ---------------------------------------------------------------------------
// Known workspace packages (dir → npmName)
// ---------------------------------------------------------------------------

const WORKSPACE_MAP: Record<string, string> = {
  "packages/core": "@tribunus/core",
  "packages/app": "@tribunus/app",
  "packages/desktop": "tribunus",
  "packages/web": "@tribunus/web",
  "packages/ui": "@tribunus/ui",
  "packages/llm": "@tribunus/llm",
  "packages/compute": "@tribunus/compute",
  "packages/compute-native": "@tribunus/compute-native",
  "packages/protocol": "@tribunus/protocol",
  "packages/opencode": "opencode",
  "packages/sdk/js": "@tribunus/sdk",
  "packages/plugin": "@tribunus/plugin",
  "packages/script": "@tribunus/script",
  "packages/slack": "@tribunus/slack",
  "packages/enterprise": "@tribunus/enterprise",
  "packages/http-recorder": "@tribunus/http-recorder",
  "packages/function": "@tribunus/function",
  "packages/storybook": "@tribunus/storybook",
  "packages/containers": "@tribunus/containers",
  "packages/github-pages-mcp": "@tribunus-ai/github-pages-mcp",
  "packages/stats/core": "@tribunus/stats-core",
  "packages/stats/app": "@tribunus/stats-app",
  "packages/stats/server": "@tribunus/stats-server",
  "packages/console/core": "@tribunus/console-core",
  "packages/console/app": "@tribunus/console-app",
  "packages/console/function": "@tribunus/console-function",
  "packages/console/support": "@tribunus/console-support",
  "packages/console/mail": "@tribunus/console-mail",
  "packages/console/resource": "@tribunus/console-resource",
};

const WORKSPACE_DIRS = Object.keys(WORKSPACE_MAP);

// ---------------------------------------------------------------------------
// Read package.json
// ---------------------------------------------------------------------------

function readPackageJson(dir: string): Record<string, unknown> {
  const path = `${dir}/package.json`;
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ---------------------------------------------------------------------------
// Build dependency graph from actual package.json
// ---------------------------------------------------------------------------

function buildDependencyGraph(): Map<string, WorkspaceDep> {
  const deps = new Map<string, WorkspaceDep>();

  for (const dir of WORKSPACE_DIRS) {
    const npmName = WORKSPACE_MAP[dir];
    const pkg = readPackageJson(dir);
    const workspaceDeps: string[] = [];
    const workspaceDevDeps: string[] = [];

    // Collect all dependency names with their type
    const allDeps = new Map<string, "dependencies" | "devDependencies">();
    const rawDeps = (pkg.dependencies ?? {}) as Record<string, string>;
    for (const name of Object.keys(rawDeps)) {
      allDeps.set(name, "dependencies");
    }
    const rawDevDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    for (const name of Object.keys(rawDevDeps)) {
      allDeps.set(name, "devDependencies");
    }

    // Match against known workspace packages
    const workspaceNpmNames = new Set(Object.values(WORKSPACE_MAP));
    for (const [depName, depType] of allDeps) {
      if (workspaceNpmNames.has(depName)) {
        if (depType === "devDependencies") {
          workspaceDevDeps.push(depName);
        } else {
          workspaceDeps.push(depName);
        }
      }
    }

    deps.set(dir, { name: depNameFromNpm(npmName), dir, npmName, workspaceDeps, workspaceDevDeps });
  }

  return deps;
}

/** Extract short name from npm package name */
function depNameFromNpm(npmName: string): string {
  const parts = npmName.split("/");
  return parts[parts.length - 1] ?? npmName;
}

// ---------------------------------------------------------------------------
// Topological sort (excludes devDependencies)
// ---------------------------------------------------------------------------

function topologicalSort(deps: Map<string, WorkspaceDep>): string[] {
  const visited = new Map<string, boolean>();
  const order: string[] = [];

  function visit(dir: string) {
    if (visited.has(dir)) return;
    visited.set(dir, true);

    const pkg = deps.get(dir)!;
    for (const depName of pkg.workspaceDeps) {
      for (const [otherDir, otherPkg] of deps) {
        if (otherPkg.npmName === depName) {
          visit(otherDir);
          break;
        }
      }
    }

    order.push(dir);
  }

  const sortedDirs = [...deps.keys()].sort();
  for (const dir of sortedDirs) {
    visit(dir);
  }

  return order;
}

// ---------------------------------------------------------------------------
// Compute leaves (packages with no workspace dependents in prod deps)
// ---------------------------------------------------------------------------

function computeLeaves(deps: Map<string, WorkspaceDep>): string[] {
  const dependents = new Map<string, Set<string>>();

  for (const [, pkg] of deps) {
    for (const depName of pkg.workspaceDeps) {
      for (const [otherDir, otherPkg] of deps) {
        if (otherPkg.npmName === depName) {
          if (!dependents.has(otherDir)) dependents.set(otherDir, new Set());
          dependents.get(otherDir)!.add(pkg.dir);
          break;
        }
      }
    }
  }

  const leaves: string[] = [];
  for (const [dir] of deps) {
    const deps_ = dependents.get(dir);
    if (!deps_ || deps_.size === 0) {
      leaves.push(dir);
    }
  }

  return leaves.sort();
}

// ---------------------------------------------------------------------------
// Find workspace consumers that reference a specific npm package
// ---------------------------------------------------------------------------

function findImportReferences(
  targetPath: string,
  targetNpmName: string,
  allPkgs: Map<string, WorkspaceDep>,
): WorkspaceRef[] {
  const refs: WorkspaceRef[] = [];

  for (const [consumerPath, pkg] of allPkgs) {
    if (consumerPath === targetPath) continue;

    const pkgJson = readPackageJson(consumerPath);
    const deps = (pkgJson.dependencies ?? {}) as Record<string, string>;
    const devDeps = (pkgJson.devDependencies ?? {}) as Record<string, string>;

    if (deps[targetNpmName] !== undefined) {
      refs.push({ consumer: pkg.name, consumerPath, depType: "dependencies" });
    }
    if (devDeps[targetNpmName] !== undefined) {
      refs.push({ consumer: pkg.name, consumerPath, depType: "devDependencies" });
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Build named graphs for output
// ---------------------------------------------------------------------------

function buildNamedGraph(deps: Map<string, WorkspaceDep>): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  for (const [, pkg] of deps) {
    graph[pkg.npmName] = [...pkg.workspaceDeps].sort();
  }
  return graph;
}

function buildNamedReverseGraph(deps: Map<string, WorkspaceDep>): Record<string, string[]> {
  const rev: Record<string, string[]> = {};

  for (const [, pkg] of deps) {
    rev[pkg.npmName] ??= [];
  }
  for (const [, pkg] of deps) {
    for (const depName of pkg.workspaceDeps) {
      rev[depName] ??= [];
      rev[depName].push(pkg.npmName);
    }
  }
  for (const key of Object.keys(rev)) {
    rev[key].sort();
  }

  return rev;
}

// ---------------------------------------------------------------------------
// Check if a package needs renaming (has opencode-ai prefix or is bare "opencode")
// ---------------------------------------------------------------------------

function needsRename(currentName: string): boolean {
  return currentName.startsWith("@opencode-ai/") || currentName === "opencode";
}

/** New npm name for a package that needs renaming */
function intendedName(currentName: string): string {
  if (currentName === "opencode") return "@tribunus/runtime";
  return currentName.replace("@opencode-ai/", "@tribunus/");
}

// ---------------------------------------------------------------------------
// Wave definitions
// ---------------------------------------------------------------------------

const WAVE_DEFS: Array<{ label: string; description: string; predicate: (path: string) => boolean }> = [
  {
    label: "Leaf Packages",
    description: "Packages with no first-party workspace dependents — safe to rename without cascading.",
    predicate: () => false, // computed dynamically
  },
  {
    label: "Foundation Packages",
    description: "Core infrastructure packages (core, llm, ui, protocol, compute) — broad consumer base, renamed early to unblock downstream.",
    predicate: (path) => {
      const f: Record<string, true> = {
        "packages/core": true,
        "packages/llm": true,
        "packages/ui": true,
        "packages/protocol": true,
        "packages/compute": true,
        "packages/compute-native": true,
      };
      return !!f[path];
    },
  },
  {
    label: "SDK & Plugin",
    description: "SDK consumed by public consumers, and Plugin (depends on SDK) — must be renamed before consumer wave.",
    predicate: (path) => path === "packages/sdk/js" || path === "packages/plugin",
  },
  {
    label: "Consumer Packages",
    description: "Application-level packages consuming foundation, SDK, and UI packages.",
    predicate: (path) => {
      const c: Record<string, true> = {
        "packages/app": true,
        "packages/desktop": true,
        "packages/web": true,
        "packages/console/core": true,
        "packages/console/app": true,
        "packages/console/function": true,
        "packages/console/support": true,
        "packages/console/mail": true,
        "packages/console/resource": true,
        "packages/stats/core": true,
        "packages/stats/app": true,
        "packages/stats/server": true,
        "packages/enterprise": true,
        "packages/slack": true,
        "packages/script": true,
        "packages/http-recorder": true,
        "packages/function": true,
        "packages/storybook": true,
        "packages/containers": true,
        "packages/github-pages-mcp": true,
      };
      return !!c[path];
    },
  },
  {
    label: "Runtime Package",
    description: "The main opencode runtime npm name change (opencode → @tribunus/runtime); last npm rename before directory move.",
    predicate: (path) => path === "packages/opencode",
  },
  {
    label: "Directory Rename",
    description: "Rename packages/opencode → packages/runtime; all npm renames already applied, only filesystem path references remain.",
    predicate: () => false, // special case handled after all others
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // 1. Read authority map
  if (!existsSync(MAP_PATH)) {
    console.error(`ERROR: Authority map not found at ${MAP_PATH}`);
    console.error("Run the authority map generator first.");
    process.exit(1);
  }

  const authMap: AuthorityMap = JSON.parse(readFileSync(MAP_PATH, "utf-8"));

  // 2. Filter first-party workspace entries that need renaming
  const renameDirs = new Map<string, AuthorityEntry>();
  const keptDirs = new Set<string>();

  for (const entry of authMap.entries) {
    if (!entry.isWorkspace || !entry.exists) continue;
    keptDirs.add(entry.path);

    // Only rename packages that still have opencode in their name
    if (entry.currentName !== entry.intendedName && needsRename(entry.currentName)) {
      renameDirs.set(entry.path, entry);
    }
  }

  // 3. Build dependency graph from all workspace package.json files
  const depMap = buildDependencyGraph();
  const leaves = new Set(computeLeaves(depMap));

  // 4. Build reverse graph
  const reverseGraph = buildNamedReverseGraph(depMap);

  // 5. Assign packages to waves
  const assigned = new Set<string>();
  const waves: MigrationWave[] = [];

  // Package dirs with designated waves (not eligible for Wave 1)
  const designatedDirs: Record<string, true> = {
    "packages/core": true,
    "packages/llm": true,
    "packages/ui": true,
    "packages/protocol": true,
    "packages/compute": true,
    "packages/compute-native": true,
    "packages/sdk/js": true,
    "packages/plugin": true,
    "packages/opencode": true,
  };

  // Wave 1: Leaves — packages no one depends on (excluding designated-wave packages)
  const wave1Pkgs: WavePackage[] = [];
  for (const [path, entry] of renameDirs) {
    if (assigned.has(path)) continue;
    if (!leaves.has(path)) continue;
    if (designatedDirs[path]) continue;
    const dep = depMap.get(path);
    wave1Pkgs.push({
      currentName: entry.currentName,
      intendedName: entry.intendedName,
      path,
      renameDirectory: false,
      targetPath: path,
      dependsOn: dep?.workspaceDeps ?? [],
      importReferences: dep ? findImportReferences(path, entry.currentName, depMap) : [],
    });
    assigned.add(path);
  }
  wave1Pkgs.sort((a, b) => a.currentName.localeCompare(b.currentName));
  if (wave1Pkgs.length > 0) {
    waves.push({ wave: 1, label: "Leaf Packages", description: "Packages with no first-party workspace dependents — safe to rename without cascading.", packages: wave1Pkgs });
  }

  // Wave 2: Foundation
  const wave2Pkgs: WavePackage[] = [];
  for (const [path, entry] of renameDirs) {
    if (assigned.has(path)) continue;
    const f: Record<string, true> = {
      "packages/core": true, "packages/llm": true, "packages/ui": true,
      "packages/protocol": true, "packages/compute": true, "packages/compute-native": true,
    };
    if (!f[path]) continue;
    const dep = depMap.get(path);
    wave2Pkgs.push({
      currentName: entry.currentName,
      intendedName: entry.intendedName,
      path,
      renameDirectory: false,
      targetPath: path,
      dependsOn: dep?.workspaceDeps ?? [],
      importReferences: dep ? findImportReferences(path, entry.currentName, depMap) : [],
    });
    assigned.add(path);
  }
  wave2Pkgs.sort((a, b) => a.currentName.localeCompare(b.currentName));
  if (wave2Pkgs.length > 0) {
    waves.push({ wave: 2, label: "Foundation Packages", description: "Core infrastructure packages (core, llm, ui, protocol, compute) — broad consumer base, renamed early to unblock downstream.", packages: wave2Pkgs });
  }

  // Wave 3: SDK + Plugin
  const wave3Pkgs: WavePackage[] = [];
  for (const [path, entry] of renameDirs) {
    if (assigned.has(path)) continue;
    if (path !== "packages/sdk/js" && path !== "packages/plugin") continue;
    const dep = depMap.get(path);
    wave3Pkgs.push({
      currentName: entry.currentName,
      intendedName: entry.intendedName,
      path,
      renameDirectory: false,
      targetPath: path,
      dependsOn: dep?.workspaceDeps ?? [],
      importReferences: dep ? findImportReferences(path, entry.currentName, depMap) : [],
    });
    assigned.add(path);
  }
  wave3Pkgs.sort((a, b) => a.currentName.localeCompare(b.currentName));
  if (wave3Pkgs.length > 0) {
    waves.push({ wave: 3, label: "SDK & Plugin", description: "SDK consumed by public consumers, and Plugin (depends on SDK) — must be renamed before consumer wave.", packages: wave3Pkgs });
  }

  // Wave 4: Consumer packages (everything except opencode)
  const wave4Pkgs: WavePackage[] = [];
  for (const [path, entry] of renameDirs) {
    if (assigned.has(path)) continue;
    if (path === "packages/opencode") continue;
    const dep = depMap.get(path);
    wave4Pkgs.push({
      currentName: entry.currentName,
      intendedName: entry.intendedName,
      path,
      renameDirectory: false,
      targetPath: path,
      dependsOn: dep?.workspaceDeps ?? [],
      importReferences: dep ? findImportReferences(path, entry.currentName, depMap) : [],
    });
    assigned.add(path);
  }
  wave4Pkgs.sort((a, b) => a.currentName.localeCompare(b.currentName));
  if (wave4Pkgs.length > 0) {
    waves.push({ wave: 4, label: "Consumer Packages", description: "Application-level packages consuming foundation, SDK, and UI packages.", packages: wave4Pkgs });
  }

  // Wave 5: Runtime (opencode → @tribunus/runtime)
  const opencodeEntry = renameDirs.get("packages/opencode");
  const wave5Pkgs: WavePackage[] = [];
  if (opencodeEntry && !assigned.has("packages/opencode")) {
    const dep = depMap.get("packages/opencode");
    const refs = dep ? findImportReferences("packages/opencode", "opencode", depMap) : [];

    // Also check devDeps for "opencode" (e.g., web has it as devDep)
    for (const [consumerPath, pkg] of depMap) {
      if (consumerPath === "packages/opencode") continue;
      const pkgJson = readPackageJson(consumerPath);
      const devDeps = (pkgJson.devDependencies ?? {}) as Record<string, string>;
      if (devDeps["opencode"] !== undefined) {
        const already = refs.some((r) => r.consumerPath === consumerPath && r.depType === "devDependencies");
        if (!already) {
          refs.push({ consumer: pkg.name, consumerPath, depType: "devDependencies" });
        }
      }
    }

    wave5Pkgs.push({
      currentName: "opencode",
      intendedName: "@tribunus/runtime",
      path: "packages/opencode",
      renameDirectory: false,
      targetPath: "packages/opencode",
      dependsOn: dep?.workspaceDeps ?? [],
      importReferences: refs,
    });
    assigned.add("packages/opencode");

    waves.push({ wave: 5, label: "Runtime Package", description: "The main opencode runtime npm name change (opencode → @tribunus/runtime); last npm rename before directory move.", packages: wave5Pkgs });
  }

  // Wave 6: Directory rename packages/opencode → packages/runtime
  if (opencodeEntry) {
    const wave6Pkgs: WavePackage[] = [{
      currentName: "opencode",
      intendedName: "@tribunus/runtime",
      path: "packages/opencode",
      renameDirectory: true,
      targetPath: "packages/runtime",
      dependsOn: [],
      importReferences: [],
    }];
    waves.push({ wave: 6, label: "Directory Rename", description: "Rename packages/opencode → packages/runtime; all npm renames already applied, only filesystem path references and imports remain.", packages: wave6Pkgs });
  }

  // Check for unassigned dirs (shouldn't happen given our coverage)
  const unassigned: string[] = [];
  for (const [path] of renameDirs) {
    if (!assigned.has(path)) {
      unassigned.push(path);
    }
  }

  // Build output
  const graph = buildNamedGraph(depMap);

  const dirRenames: string[] = [];
  if (opencodeEntry) {
    dirRenames.push("packages/opencode → packages/runtime");
  }

  const output: PlanOutput = {
    waves,
    graph,
    reverseGraph,
    summary: {
      totalFirstParty: authMap.metadata.firstPartyCount,
      totalRenamed: renameDirs.size,
      totalWaves: waves.length,
      directoryRenames: dirRenames,
    },
  };

  // Ensure output directory
  mkdirSync(dirname(WAVES_JSON), { recursive: true });
  writeFileSync(WAVES_JSON, JSON.stringify(output, null, 2));

  // Generate human-readable plan
  const planMd = generatePlanMarkdown(output, authMap, renameDirs);
  mkdirSync(dirname(PLAN_MD), { recursive: true });
  writeFileSync(PLAN_MD, planMd);

  console.log(`\n  ✓ ${WAVES_JSON}`);
  console.log(`  ✓ ${PLAN_MD}`);
  console.log(`  ────────────────────────────────────`);
  console.log(`  First-party packages: ${output.summary.totalFirstParty}`);
  console.log(`  Packages to rename:   ${output.summary.totalRenamed}`);
  console.log(`  Migration waves:      ${output.summary.totalWaves}`);
  for (const dr of output.summary.directoryRenames) {
    console.log(`  Directory rename:     ${dr}`);
  }
  if (unassigned.length > 0) {
    console.log(`  WARNING: Unassigned: ${unassigned.join(", ")}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Generate human-readable plan
// ---------------------------------------------------------------------------

function generatePlanMarkdown(
  plan: PlanOutput,
  authMap: AuthorityMap,
  _renameDirs: Map<string, AuthorityEntry>,
): string {
  const lines: string[] = [];

  lines.push("# Source Identity Cutover — Migration Plan");
  lines.push("");
  lines.push(`Legacy scope: \`@opencode-ai/\``);
  lines.push(`Canonical scope: \`@tribunus/\``);
  lines.push(`Generated: ${authMap.metadata.generatedAt}`);
  lines.push(`Source: \`${authMap.metadata.source}\``);
  lines.push(`Total first-party packages: ${plan.summary.totalFirstParty}`);
  lines.push(`Packages requiring rename: ${plan.summary.totalRenamed}`);
  lines.push(`Migration waves: ${plan.summary.totalWaves}`);
  lines.push("");

  // Package table
  lines.push("## Package Rename Table");
  lines.push("");
  lines.push("| Current Name | Intended Name | Path | Deps | Consumers |");
  lines.push("|---|---|---|---|---|");
  for (const wave of plan.waves) {
    for (const pkg of wave.packages) {
      if (pkg.currentName === pkg.intendedName) continue;
      const depNames = pkg.dependsOn.length > 0 ? pkg.dependsOn.join(", ") : "—";
      const consumerNames = pkg.importReferences.length > 0
        ? pkg.importReferences.map((r) => r.consumer).join(", ")
        : "—";
      lines.push(`| \`${pkg.currentName}\` | \`${pkg.intendedName}\` | \`${pkg.path}\` | ${depNames} | ${consumerNames} |`);
    }
  }
  lines.push("");

  // Dependency graph
  lines.push("## Production Dependency Graph");
  lines.push("");
  lines.push("```");
  for (const [name, deps] of Object.entries(plan.graph)) {
    const d = deps.length > 0 ? deps.join(", ") : "(none)";
    lines.push(`  ${name} → ${d}`);
  }
  lines.push("```");
  lines.push("");

  // Reverse dependency graph
  lines.push("## Reverse Dependency Graph (who depends on whom)");
  lines.push("");
  lines.push("```");
  for (const [name, consumers] of Object.entries(plan.reverseGraph)) {
    const c = consumers.length > 0 ? consumers.join(", ") : "(no workspace consumers)";
    lines.push(`  ${name} ← ${c}`);
  }
  lines.push("```");
  lines.push("");

  // Per-wave details
  for (const wave of plan.waves) {
    lines.push(`## Wave ${wave.wave}: ${wave.label}`);
    lines.push("");
    lines.push(wave.description);
    lines.push("");
    lines.push(`**Packages:** ${wave.packages.length}`);
    lines.push("");

    for (const pkg of wave.packages) {
      if (pkg.renameDirectory) {
        lines.push("### Directory Rename");
        lines.push("");
        lines.push(`- **From:** \`${pkg.path}\``);
        lines.push(`- **To:** \`${pkg.targetPath}\``);
        lines.push(`- **Associated npm name:** \`${pkg.currentName}\` → \`${pkg.intendedName}\``);
        lines.push("");
        lines.push("**NOTE:** All npm renames in Wave 5 must be complete before this wave executes.");
        lines.push("");
        continue;
      }

      if (pkg.currentName === pkg.intendedName) continue;

      lines.push(`### \`${pkg.currentName}\` → \`${pkg.intendedName}\``);
      lines.push("");
      lines.push(`- **Location:** \`${pkg.path}\``);
      lines.push(`- **Workspace production deps:** ${pkg.dependsOn.length > 0 ? pkg.dependsOn.join(", ") : "(none)"}`);
      lines.push("");

      if (pkg.importReferences.length > 0) {
        lines.push("**Import references to update in \`package.json\`:**");
        lines.push("");
        lines.push("| Consumer | Package | Dep Type |");
        lines.push("|----------|---------|----------|");
        for (const ref of pkg.importReferences) {
          lines.push(`| \`${ref.consumerPath}/package.json\` | \`${ref.consumer}\` | ${ref.depType} |`);
        }
        lines.push("");
      } else {
        lines.push("**No workspace import references to update.**");
        lines.push("");
      }
    }
  }

  // Directory rename summary
  if (plan.summary.directoryRenames.length > 0) {
    lines.push("## Directory Renames");
    lines.push("");
    for (const dr of plan.summary.directoryRenames) {
      lines.push(`- ${dr}`);
    }
    lines.push("");
  }

  // Execution order
  lines.push("## Execution Order");
  lines.push("");
  lines.push("Execute waves sequentially. Each wave must be verified before proceeding to the next.");
  lines.push("");
  for (const wave of plan.waves) {
    const renameCount = wave.packages.filter((p) => p.currentName !== p.intendedName).length;
    const waveSuffix = wave.packages.length > 0
      ? (wave.packages[0]?.renameDirectory ? "1 directory" : `${renameCount} package${renameCount !== 1 ? "s" : ""}`)
      : "0 packages";
    lines.push(`1. **Wave ${wave.wave} — ${wave.label}** (${waveSuffix})`);
    for (const pkg of wave.packages) {
      if (pkg.renameDirectory) {
        lines.push(`   - Rename directory: \`${pkg.path}\` → \`${pkg.targetPath}\``);
      } else if (pkg.currentName !== pkg.intendedName) {
        lines.push(`   - Rename \`${pkg.currentName}\` → \`${pkg.intendedName}\` in \`${pkg.path}/package.json\``);
        if (pkg.importReferences.length > 0) {
          const uniqueConsumers = [...new Set(pkg.importReferences.map((r) => r.consumerPath))];
          lines.push(`   - Update references in: ${uniqueConsumers.map((c) => `\`${c}/package.json\``).join(", ")}`);
        }
      }
    }
    lines.push(`   - Verify: \`bun run scripts/identity/verify-identity.ts\``);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------

main();
