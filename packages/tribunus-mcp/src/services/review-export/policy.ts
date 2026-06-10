// Policy — inclusion/exclusion rules for code review export
import { REQUIRE_MISSING_FAIL } from "./constants.js";
import { extOf, filenameOf, isSafePath, matchesFilenamePrefix } from "./fs-utils.js";
import type { ExclusionEntry } from "./types.js";

// Include by extension (in priority order — checked first)
const INCLUDE_EXTENSIONS: Record<string, true> = {
  ".ts": true, ".tsx": true, ".js": true, ".jsx": true,
  ".mjs": true, ".cjs": true, ".mts": true, ".cts": true,
  ".json": true, ".jsonc": true,
  ".md": true, ".mdx": true,
  ".css": true, ".scss": true, ".sass": true,
  ".html": true, ".htm": true,
  ".yml": true, ".yaml": true, ".toml": true,
  ".rs": true, ".go": true, ".py": true, ".swift": true,
  ".sh": true, ".bash": true, ".zsh": true,
  ".sql": true, ".graphql": true, ".gql": true,
  ".proto": true, ".vue": true, ".svelte": true,
  ".metal": true,
};

// Include by filename
const INCLUDE_FILENAMES: Record<string, true> = {
  "package.json": true, "Dockerfile": true, "Makefile": true,
  "AGENTS.md": true, "CONTEXT.md": true, "README.md": true,
  ".oxlintrc.json": true, "bunfig.toml": true, "turbo.json": true,
  "LICENSE": true, "NOTICE": true, "CHANGELOG.md": true, "SECURITY.md": true,
  "bun.lock": true, "bun.lockb": true,
  "pnpm-lock.yaml": true, "yarn.lock": true, "package-lock.json": true,
};

// Named config patterns (checked by prefix)
const INCLUDE_FILENAME_PREFIXES: Array<string> = [
  "tsconfig", "vite.config.", "vitest.config.", "eslint.config.", "prettier.config.",
];

// Include directories unconditionally (recursive for certain ext sets)
const INCLUDE_DIR_PREFIXES: Array<string> = [
  ".omp/tools/", "schemas/", "scripts/", "script/", "infra/", "nix/",
];

// Include by glob — docs uses ext filter, packages/src and packages/test/tests use ext filter
const INCLUDE_DIR_PATTERNS: Array<{
  prefix: string;
  extFilter?: Record<string, true>;
  nameFilter?: Record<string, true>;
}> = [
  { prefix: "docs/", extFilter: { ".json": true, ".md": true, ".sql": true } },
  { prefix: ".github/workflows/", extFilter: INCLUDE_EXTENSIONS },
  { prefix: "packages/", extFilter: INCLUDE_EXTENSIONS, nameFilter: INCLUDE_FILENAMES },
];

// Hidden dirs that are never included
const HARD_EXCLUDE_SEGMENTS: Record<string, true> = {
  ".git": true, "node_modules": true, "dist": true, "build": true,
  "coverage": true, ".next": true, ".turbo": true, ".cache": true,
  ".parcel-cache": true, ".vite": true, "out": true, "target": true,
  "vendor": true, "__generated__": true, "generated": true,
};

const HARD_EXCLUDE_PREFIXES: Array<string> = [
  ".omp/state/", ".omp/evidence/",
  ".omp/tools/receipts/", ".omp/tools/diffs/", ".omp/tools/journals/", ".omp/tools/events/",
  ".omp/tools/bun.lock",
];

const HARD_EXCLUDE_FILENAMES: Record<string, true> = {
  ".env": true, ".env.local": true, ".env.development": true,
  ".env.production": true, ".npmrc": true, ".pypirc": true,
  "id_rsa": true, "id_ed25519": true,
  "dump.sql": true, "backup.sql": true, "seed-production.sql": true,
  "production.sql": true, "staging.sql": true,
};

const HARD_EXCLUDE_EXTENSIONS: Record<string, true> = {
  ".pem": true, ".key": true, ".p12": true, ".pfx": true,
  ".env": true,
};

// ─── Helpers ───────────────────────────────────────────────────────────

const OVERRIDE_ALWAYS_INCLUDE: Record<string, true> = {};
for (const rp of REQUIRE_MISSING_FAIL) {
  OVERRIDE_ALWAYS_INCLUDE[rp] = true;
}

function shouldIncludePath(
  relPath: string,
  exclusions: ExclusionEntry[],
): { include: true } | { include: false; reason: string } {
  if (!isSafePath(relPath)) return { include: false, reason: "unsafe path" };

  const base = filenameOf(relPath);
  const ext = extOf(relPath);

  // Hard exclusions — short-circuit first
  if (base in HARD_EXCLUDE_FILENAMES) {
    return { include: false, reason: `excluded filename: ${base}` };
  }
  if (ext in HARD_EXCLUDE_EXTENSIONS && relPath !== ".env.example") {
    return { include: false, reason: `excluded extension: ${ext}` };
  }

  // Check segments (e.g. node_modules, dist)
  const segs = relPath.split("/");
  for (const seg of segs) {
    if (seg in HARD_EXCLUDE_SEGMENTS) {
      return { include: false, reason: `excluded segment: ${seg}` };
    }
  }

  // Check hard exclude prefixes
  for (const prefix of HARD_EXCLUDE_PREFIXES) {
    if (relPath.startsWith(prefix)) {
      return { include: false, reason: `excluded prefix: ${prefix}` };
    }
  }

  // Override: required paths always included
  if (relPath in OVERRIDE_ALWAYS_INCLUDE) {
    return { include: true };
  }

  // ─── Positive inclusion ──────────────────────────────────────────────

  // Include by extension
  if (ext in INCLUDE_EXTENSIONS) {
    return { include: true };
  }

  // Include by exact filename
  if (base in INCLUDE_FILENAMES) {
    return { include: true };
  }

  // Include by filename prefix
  if (matchesFilenamePrefix(base, INCLUDE_FILENAME_PREFIXES)) {
    return { include: true };
  }

  // Include by .omp/tools prefix (all source, no further filtering needed — override covers required)
  if (relPath.startsWith(".omp/tools/")) {
    // Only include text files (ts, json, md) inside .omp/tools
    if (ext === ".ts" || ext === ".json" || ext === ".jsonc" || ext === ".md" || ext === ".yml" || ext === ".yaml" || ext === ".toml" || ext === ".py" || ext === ".sql") {
      return { include: true };
    }
    return { include: false, reason: ".omp/tools content excluded by extension" };
  }

  // Include directories unconditionally (with extension filter)
  for (const dirPrefix of INCLUDE_DIR_PREFIXES) {
    if (relPath.startsWith(dirPrefix)) {
      const ext = extOf(relPath);
      if (ext === ".ts" || ext === ".json" || ext === ".jsonc" || ext === ".md" || ext === ".yml" || ext === ".yaml" || ext === ".toml" || ext === ".py" || ext === ".sh" || ext === ".bash") {
        return { include: true };
      }
      return { include: false, reason: `excluded by extension in ${dirPrefix}` };
    }
  }

  // Include dir patterns
  for (const pattern of INCLUDE_DIR_PATTERNS) {
    if (relPath.startsWith(pattern.prefix)) {
      const ext = extOf(relPath);
      if (pattern.extFilter && ext in pattern.extFilter) {
        return { include: true };
      }
      if (pattern.nameFilter && base in pattern.nameFilter) {
        return { include: true };
      }
      return { include: false, reason: `not in allowed types for ${pattern.prefix}` };
    }
  }

  return { include: false, reason: "not in any inclusion set" };
}

export {
  INCLUDE_EXTENSIONS,
  INCLUDE_FILENAMES,
  INCLUDE_FILENAME_PREFIXES,
  INCLUDE_DIR_PREFIXES,
  INCLUDE_DIR_PATTERNS,
  HARD_EXCLUDE_SEGMENTS,
  HARD_EXCLUDE_PREFIXES,
  HARD_EXCLUDE_FILENAMES,
  HARD_EXCLUDE_EXTENSIONS,
  OVERRIDE_ALWAYS_INCLUDE,
  shouldIncludePath,
};
