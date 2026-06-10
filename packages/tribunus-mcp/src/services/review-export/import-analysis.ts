// ─── Review Export Import Analysis ─────────────────────────────────────────────

import { existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { extOf, sourceEquivalentExtensionsFor } from "./fs-utils.js";
import type { ImportFinding, ReviewScope } from "./types.js";

export function extractRelativeImports(source: string): string[] {
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

export function resolveRelativeImportTarget(importer: string, specifier: string, repoRoot: string): string | undefined {
  const candidates = resolveImportCandidates(importer, specifier, repoRoot);
  for (const candidate of candidates) {
    if (existsSync(resolve(repoRoot, candidate))) return candidate;
  }
  return undefined;
}

export function resolveImportCandidates(importer: string, specifier: string, repoRoot: string): string[] {
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

export function classifyUnresolvedImport(importer: string, specifier: string, repoRoot: string): "missing_source_import" | "missing_asset_import" | "missing_prompt_template" | "missing_generated_type" | "missing_media_asset" | "missing_route_target" | "ts_js_extension_remap" | "resolved_but_excluded" | "external_import" {
  if (!specifier.startsWith(".")) return "external_import";
  const remapped = resolveImportCandidates(importer, specifier, repoRoot);
  const existing = remapped.filter((candidate) => existsSync(resolve(repoRoot, candidate)));
  if (existing.length > 0) return "resolved_but_excluded";
  if (specifier.endsWith(".js") || specifier.endsWith(".jsx") || specifier.endsWith(".mjs") || specifier.endsWith(".cjs")) return "ts_js_extension_remap";
  const ext = extOf(specifier);
  if ([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".mp4", ".mov", ".webm", ".m4v", ".avi", ".mp3", ".wav", ".ogg"].includes(ext)) return "missing_media_asset";
  if ([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".css", ".scss", ".sass"].includes(ext)) return "missing_asset_import";
  if (specifier.includes("/prompt/") || specifier.endsWith(".txt")) return "missing_prompt_template";
  if (specifier.includes("generated") || specifier.includes("dist/") || specifier.includes("/types/") || specifier.endsWith(".d.ts")) return "missing_generated_type";
  if (specifier.includes("/route/") || specifier.includes("/routes/")) return "missing_route_target";
  return "missing_source_import";
}

export function unresolvedImportCategoryForStatus(status: string): "missing_source" | "missing_asset" | "missing_generated" | "missing_prompt_template" | "missing_route_target" | "resolved_not_embedded" | "ts_js_extension_remap" {
  switch (status) {
    case "missing_asset":
      return "missing_asset";
    case "missing_generated":
      return "missing_generated";
    case "missing_prompt_template":
      return "missing_prompt_template";
    case "missing_route_target":
      return "missing_route_target";
    case "ts_js_extension_remap":
      return "ts_js_extension_remap";
    case "resolved_not_embedded":
      return "resolved_not_embedded";
    default:
      return "missing_source";
  }
}

export function unresolvedImportSeverityForStatus(status: string, reviewScope: ReviewScope): "info" | "warning" | "critical" {
  switch (status) {
    case "missing_asset":
      return reviewScope === "release_ui" ? "warning" : "info";
    case "missing_generated":
    case "missing_source":
      return "critical";
    case "missing_prompt_template":
    case "missing_route_target":
    case "resolved_not_embedded":
      return "warning";
    case "ts_js_extension_remap":
      return "info";
    default:
      return "warning";
  }
}

export function classifyResolvedNotEmbedded(resolvedPath: string, importerPath: string): { severity: "warning" | "info" | "ignored" } {
  const ext = extOf(resolvedPath);
  if (
    resolvedPath.includes("generated") ||
    resolvedPath.includes("dist/") ||
    resolvedPath.includes("/types/") ||
    resolvedPath.endsWith(".d.ts") ||
    resolvedPath.includes("/node_modules/") ||
    [".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".mp4", ".mov", ".webm", ".m4v", ".avi", ".mp3", ".wav", ".ogg", ".css", ".scss", ".sass"].includes(ext)
  ) {
    return { severity: "ignored" };
  }

  if (importerPath.startsWith(".omp/tools/") || resolvedPath.startsWith(".omp/tools/")) {
    return { severity: "warning" };
  }

  return { severity: "info" };
}

export function severityWeight(severity: "info" | "warning" | "critical"): number {
  return severity === "critical" ? 2 : severity === "warning" ? 1 : 0;
}

export function isKnownExtension(ext: string): boolean {
  const known = [
    ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json", ".jsonc",
    ".css", ".scss", ".sass", ".html", ".htm", ".sql", ".md", ".mdx", ".yml", ".yaml", ".toml"
  ];
  return known.includes(ext.toLowerCase());
}

export function classifyImportFinding(args: {
  importer: string;
  specifier: string;
  repoRoot: string;
  resolved?: string;
  includedSet: Set<string>;
}): ImportFinding | undefined {
  if (!args.specifier.startsWith(".")) return { importer: args.importer, specifier: args.specifier, kind: "external" };

  if (args.resolved) {
    if (args.includedSet.has(args.resolved)) return undefined
    return { importer: args.importer, specifier: args.specifier, resolved: args.resolved, kind: "not_included" }
  }

  const remappedCandidates = resolveImportCandidates(args.importer, args.specifier, args.repoRoot)
  const remapped = remappedCandidates.find((candidate) => existsSync(resolve(args.repoRoot, candidate)))
  if (remapped) {
    return { importer: args.importer, specifier: args.specifier, resolved: remapped, kind: "remap" }
  }

  return { importer: args.importer, specifier: args.specifier, kind: "missing" }
}
