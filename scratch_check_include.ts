import factory from "./.omp/tools/code_review_export";
import { z } from "zod";

// Let's copy shouldIncludePath from code_review_export
const REQUIRE_MISSING_FAIL = [
  ".omp/tools/struct_read.ts",
  ".omp/tools/text_replace.ts",
  ".omp/tools/batch_edit.ts",
  ".omp/tools/code_review_export.ts",
  ".omp/tools/_lib/types.ts",
  ".omp/tools/_lib/envelope.ts",
  ".omp/tools/_lib/path-policy.ts",
  ".omp/tools/_lib/hashing.ts",
  ".omp/tools/_lib/receipts.ts",
  ".omp/tools/_lib/diff.ts",
  ".omp/tools/_lib/manifest.ts",
  ".omp/tools/_lib/schemas.ts",
  ".omp/tools/_lib/errors.ts",
  ".omp/tools/_lib/ids.ts",
  ".omp/tools/_lib/json.ts",
  ".omp/tools/_lib/audit.ts",
  ".omp/tools/_lib/tool-context.ts",
  ".omp/tools/_lib/write-journal.ts",
  ".omp/tools/_lib/text-file.ts",
  ".omp/tools/_lib/redaction.ts",
  ".omp/tools/manifests/struct_read.v1.json",
  ".omp/tools/manifests/text_replace.v1.json",
  ".omp/tools/manifests/batch_edit.v1.json",
  ".omp/tools/tests/path-policy.test.ts",
  ".omp/tools/tests/receipts.test.ts",
  ".omp/tools/tests/text_replace.test.ts",
  ".omp/tools/tests/batch_edit.test.ts",
  ".omp/tools/tests/struct_read.test.ts",
  ".omp/tools/tests/manifest.test.ts",
  ".omp/tools/tests/export-completeness.test.ts",
  ".omp/mcp.json",
  ".omp/mcp-manifest.v1.json",
  "package.json",
  "AGENTS.md",
];

const OVERRIDE_ALWAYS_INCLUDE: Record<string, true> = {};
for (const rp of REQUIRE_MISSING_FAIL) {
  OVERRIDE_ALWAYS_INCLUDE[rp] = true;
}

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

const INCLUDE_FILENAMES: Record<string, true> = {
  "package.json": true, "Dockerfile": true, "Makefile": true,
  "AGENTS.md": true, "CONTEXT.md": true, "README.md": true,
  ".oxlintrc.json": true, "bunfig.toml": true, "turbo.json": true,
  "LICENSE": true, "NOTICE": true, "CHANGELOG.md": true, "SECURITY.md": true,
  "bun.lock": true, "bun.lockb": true,
  "pnpm-lock.yaml": true, "yarn.lock": true, "package-lock.json": true,
};

const INCLUDE_DIR_PREFIXES: Array<string> = [
  ".omp/tools/", "schemas/", "scripts/", "script/", "infra/", "nix/",
];

const INCLUDE_DIR_PATTERNS: Array<{
  prefix: string;
  extFilter?: Record<string, true>;
  nameFilter?: Record<string, true>;
}> = [
  { prefix: "docs/", extFilter: { ".json": true, ".md": true, ".sql": true } },
  { prefix: ".github/workflows/", extFilter: INCLUDE_EXTENSIONS },
  { prefix: "packages/", extFilter: INCLUDE_EXTENSIONS, nameFilter: INCLUDE_FILENAMES },
];

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

function extOf(p: string): string {
  const base = p.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.substring(dot) : "";
}

function filenameOf(p: string): string {
  return p.split("/").pop() || "";
}

function matchesFilenamePrefix(name: string, prefixes: string[]): boolean {
  for (const p of prefixes) {
    if (name.startsWith(p)) return true;
  }
  return false;
}

const INCLUDE_FILENAME_PREFIXES: Array<string> = [
  "tsconfig", "vite.config.", "vitest.config.", "eslint.config.", "prettier.config.",
];

function isSafePath(p: string): boolean {
  if (p.startsWith("/")) return false;
  const segs = p.split("/");
  if (segs.includes("..") || segs.includes(".")) return false;
  return true;
}

function shouldIncludePath(
  relPath: string,
  exclusions: any[],
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

console.log("account.sql.ts inclusion:", shouldIncludePath("packages/console/core/src/schema/account.sql.ts", []));
