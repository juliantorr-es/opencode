import { default as factory } from "./.omp/tools/code_review_export";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// Let's copy resolveImportCandidates from code_review_export
function extOf(p: string): string {
  const base = p.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.substring(dot) : "";
}

function sourceEquivalentExtensionsFor(specifier: string): string[] {
  if (specifier.endsWith(".js")) return [".ts", ".tsx", ".mts", ".cts", ".js"]
  if (specifier.endsWith(".jsx")) return [".tsx", ".jsx"]
  if (specifier.endsWith(".mjs")) return [".mts", ".mjs"]
  if (specifier.endsWith(".cjs")) return [".cts", ".cjs"]
  if (specifier.endsWith(".sql")) return [".sql.ts", ".ts", ".sql"]
  return [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json"]
}

function isKnownExtension(ext: string): boolean {
  const known = [
    ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json", ".jsonc",
    ".css", ".scss", ".sass", ".html", ".htm", ".sql", ".md", ".mdx", ".yml", ".yaml", ".toml"
  ];
  return known.includes(ext.toLowerCase());
}

function resolveImportCandidates(importer: string, specifier: string, repoRoot: string): string[] {
  const { dirname, relative } = require("node:path");
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

const repoRoot = process.cwd();
const importer = "packages/console/core/src/account.ts";
const specifier = "./schema/account.sql";
console.log("Candidates:", resolveImportCandidates(importer, specifier, repoRoot));
const resolved = resolveImportCandidates(importer, specifier, repoRoot).find(c => existsSync(resolve(repoRoot, c)));
console.log("Resolved:", resolved);
