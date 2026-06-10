// ─── Tree-Sitter Parsing ───────────────────────────────────────────
// Extracted from code_review_export.ts — tree-sitter and TS compiler parsing

import type { Node, Parser, Language } from "web-tree-sitter";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { languageForPath, sourceLikeExtensions } from "./fs-utils.js";
import { scriptKindForPath } from "./ts-analysis.js";
import type { SourceAnchorV1 } from "./types.js";

// ─── Helpers ────────────────────────────────────────────────────────

// ─── Exports ────────────────────────────────────────────────────────

export function isSourceLike(path: string): boolean {
  return sourceLikeExtensions(path) || path.endsWith(".mts") || path.endsWith(".cts");
}

export function parseStatusForPath(path: string, text: string): "parsed" | "parse_error" | "unsupported_language" | "not_source" {
  if (path.endsWith(".json") || path.endsWith(".jsonc")) {
    try {
      JSON.parse(text);
      return "parsed";
    } catch {
      return "parse_error";
    }
  }
  if (path.endsWith(".sql")) return "parsed";
  if (path.endsWith(".md") || path.endsWith(".txt") || path.endsWith(".yml") || path.endsWith(".yaml") || path.endsWith(".toml")) return "not_source";
  if (!isSourceLike(path)) return "not_source";
  try {
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindForPath(path));
    const parseDiagnostics = (sf as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    return parseDiagnostics.length > 0 ? "parse_error" : "parsed";
  } catch {
    return "parse_error";
  }
}

export function resolveWasmAsset(asset: string): string {
  if (asset.startsWith("file://")) return fileURLToPath(asset);
  if (asset.startsWith("/")) return asset;
  return fileURLToPath(new URL(asset, import.meta.url));
}

type TreeSitterBundle = {
  typescript: Language;
  tsx: Language;
};

let treeSitterBundlePromise: Promise<TreeSitterBundle> | null = null;

export async function getTreeSitterBundle(): Promise<TreeSitterBundle> {
  if (!treeSitterBundlePromise) {
    treeSitterBundlePromise = (async () => {
      const { Parser, Language } = await import("web-tree-sitter");
      const { default: treeWasm } = await import("web-tree-sitter/web-tree-sitter.wasm");
      const { default: tsWasm } = await import("tree-sitter-typescript/tree-sitter-typescript.wasm");
      const { default: tsxWasm } = await import("tree-sitter-typescript/tree-sitter-tsx.wasm");
      await Parser.init({ locateFile: () => resolveWasmAsset(treeWasm) });
      const [typescript, tsx] = await Promise.all([
        Language.load(resolveWasmAsset(tsWasm)),
        Language.load(resolveWasmAsset(tsxWasm)),
      ]);
      return { typescript, tsx };
    })();
  }
  return treeSitterBundlePromise;
}

export async function treeSitterParseStatus(path: string, text: string): Promise<"parsed" | "parse_error" | "unsupported_language" | "not_source"> {
  if (!isSourceLike(path)) {
    if (path.endsWith(".json") || path.endsWith(".jsonc")) {
      try {
        JSON.parse(text);
        return "parsed";
      } catch {
        return "parse_error";
      }
    }
    if (path.endsWith(".sql")) return "parsed";
    if (path.endsWith(".md") || path.endsWith(".txt") || path.endsWith(".yml") || path.endsWith(".yaml") || path.endsWith(".toml")) return "not_source";
    return "not_source";
  }

  try {
    const { Parser } = await import("web-tree-sitter");
    const bundle = await getTreeSitterBundle();
    const parser = new Parser();
    parser.setLanguage(path.endsWith(".tsx") || path.endsWith(".jsx") ? bundle.tsx : bundle.typescript);
    const tree = parser.parse(text)
    return tree?.rootNode.hasError ? "parse_error" : tree ? "parsed" : "parse_error"
  } catch {
    return "unsupported_language";
  }
}
