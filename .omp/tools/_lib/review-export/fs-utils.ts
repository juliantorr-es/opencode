// ─── Review Export FS Utilities ──────────────────────────────────────────────

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { builtinModules } from "node:module";

export function listFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(p));
    } else {
      results.push(p);
    }
  }
  return results;
}

export const BUILTIN_SPECIFIERS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

export function isBuiltinSpecifier(specifier: string): boolean {
  return BUILTIN_SPECIFIERS.has(specifier) || BUILTIN_SPECIFIERS.has(specifier.replace(/^node:/, ""));
}

export function languageForPath(path: string): string {
  if (path.endsWith(".ts")) return "typescript";
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".js")) return "javascript";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".json") || path.endsWith(".jsonc")) return "json";
  if (path.endsWith(".sql")) return "sql";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".sh") || path.endsWith(".bash")) return "shell";
  return "unknown";
}

export function lineCountForText(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function extOf(p: string): string {
  const base = p.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.substring(dot) : "";
}

export function filenameOf(p: string): string {
  return p.split("/").pop() || "";
}

export function isSafePath(p: string): boolean {
  if (p.startsWith("/")) return false;
  for (const seg of p.split("/")) {
    if (seg === ".." || seg === "") return false;
  }
  return true;
}

export function matchesFilenamePrefix(name: string, prefixes: string[]): boolean {
  for (const p of prefixes) {
    if (name.startsWith(p)) return true;
  }
  return false;
}

export function sourceLikeExtensions(path: string): boolean {
  return (
    path.endsWith(".ts") ||
    path.endsWith(".tsx") ||
    path.endsWith(".js") ||
    path.endsWith(".jsx") ||
    path.endsWith(".mts") ||
    path.endsWith(".cts") ||
    path.endsWith(".mjs") ||
    path.endsWith(".cjs")
  );
}

export function collectRelativeImportSpecifiers(content: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /(?:import|export)\s+[^'"`]*?from\s+["'`]([^"'`]+)["'`]/g,
    /import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /require\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]?.startsWith(".")) specs.add(match[1]);
    }
  }
  return [...specs];
}

export function sourceEquivalentExtensionsFor(specifier: string): string[] {
  if (specifier.endsWith(".js")) return [".ts", ".tsx", ".mts", ".cts", ".js"]
  if (specifier.endsWith(".jsx")) return [".tsx", ".jsx"]
  if (specifier.endsWith(".mjs")) return [".mts", ".mjs"]
  if (specifier.endsWith(".cjs")) return [".cts", ".cjs"]
  if (specifier.endsWith(".sql")) return [".sql.ts", ".ts", ".sql"]
  return [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json"]
}

export function isKnownExtension(ext: string): boolean {
  const known = [
    ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json", ".jsonc",
    ".css", ".scss", ".sass", ".html", ".htm", ".sql", ".md", ".mdx", ".yml", ".yaml", ".toml"
  ];
  return known.includes(ext.toLowerCase());
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
