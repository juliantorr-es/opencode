export type CodeFileCategoryV1 =
  | "omp_tool"
  | "omp_kernel"
  | "omp_manifest"
  | "omp_test"
  | "pglite_store"
  | "duckdb_projection"
  | "mcp_config"
  | "package_source"
  | "package_test"
  | "schema"
  | "adr"
  | "board_artifact"
  | "workflow"
  | "script"
  | "config"
  | "doc"
  | "asset"
  | "excluded"

export type CodeFileClassificationV1 = {
  category: CodeFileCategoryV1
  importance: "authority_critical" | "review_context" | "background" | "low_signal"
  inclusion_status: "included" | "indexed_only" | "excluded"
  parse_status: "pending" | "parsed" | "parse_error" | "unsupported_language" | "not_source"
  language?: string
}

const TEXT_EXTENSIONS: Record<string, true> = {
  ".ts": true,
  ".tsx": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".cjs": true,
  ".mts": true,
  ".cts": true,
  ".json": true,
  ".jsonc": true,
  ".md": true,
  ".mdx": true,
  ".sql": true,
  ".yaml": true,
  ".yml": true,
  ".toml": true,
  ".txt": true,
  ".sh": true,
  ".bash": true,
  ".zsh": true,
  ".css": true,
  ".scss": true,
  ".html": true,
  ".htm": true,
}

const ASSET_EXTENSIONS: Record<string, true> = {
  ".png": true,
  ".jpg": true,
  ".jpeg": true,
  ".gif": true,
  ".webp": true,
  ".svg": true,
  ".ico": true,
  ".mp4": true,
  ".mov": true,
  ".mp3": true,
  ".wav": true,
  ".pdf": true,
  ".zip": true,
  ".tar": true,
  ".gz": true,
  ".xz": true,
}

const HARD_EXCLUDED_SEGMENTS: Record<string, true> = {
  ".git": true,
  "node_modules": true,
  "dist": true,
  "build": true,
  "coverage": true,
  ".turbo": true,
  ".cache": true,
  ".next": true,
  "out": true,
  "target": true,
  "vendor": true,
  "__generated__": true,
  "generated": true,
}

const HARD_EXCLUDED_PREFIXES = [".omp/state/", ".omp/evidence/"]

function filenameOf(path: string): string {
  return path.split("/").pop() ?? path
}

function extensionOf(path: string): string {
  const file = filenameOf(path)
  const idx = file.lastIndexOf(".")
  return idx >= 0 ? file.slice(idx).toLowerCase() : ""
}

function isHardExcluded(path: string): boolean {
  if (HARD_EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return true
  return path.split("/").some((segment) => HARD_EXCLUDED_SEGMENTS[segment] === true)
}

export function isTextLikePath(path: string): boolean {
  return TEXT_EXTENSIONS[extensionOf(path)] === true || filenameOf(path) === "Dockerfile" || filenameOf(path) === "Makefile"
}

export function isAssetPath(path: string): boolean {
  return ASSET_EXTENSIONS[extensionOf(path)] === true
}

export function isSourceLikePath(path: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".sql", ".json", ".jsonc", ".md", ".mdx", ".yaml", ".yml", ".toml"].includes(extensionOf(path))
}

export function classifyFilePath(path: string): CodeFileClassificationV1 {
  if (isHardExcluded(path)) {
    return {
      category: "excluded",
      importance: "low_signal",
      inclusion_status: "excluded",
      parse_status: "not_source",
    }
  }

  const ext = extensionOf(path)
  const base = filenameOf(path)

  if (path === ".omp/mcp.json" || path === ".omp/mcp-manifest.v1.json") {
    return {
      category: "mcp_config",
      importance: "authority_critical",
      inclusion_status: "included",
      parse_status: "parsed",
      language: "json",
    }
  }

  if (path.startsWith(".omp/tools/manifests/")) {
    return {
      category: "omp_manifest",
      importance: "authority_critical",
      inclusion_status: "included",
      parse_status: "parsed",
      language: "json",
    }
  }

  if (path.startsWith(".omp/tools/tests/")) {
    return {
      category: "omp_test",
      importance: "authority_critical",
      inclusion_status: "included",
      parse_status: "parsed",
      language: ext === ".sql" ? "sql" : "ts",
    }
  }

  if (path.startsWith(".omp/tools/_lib/store/migrations/") || ext === ".sql") {
    return {
      category: "schema",
      importance: "authority_critical",
      inclusion_status: "included",
      parse_status: "parsed",
      language: "sql",
    }
  }

  if (path.startsWith(".omp/tools/_lib/store/")) {
    return {
      category: "pglite_store",
      importance: "authority_critical",
      inclusion_status: "included",
      parse_status: isTextLikePath(path) ? "parsed" : "not_source",
      language: isTextLikePath(path) ? (ext === ".json" ? "json" : "ts") : undefined,
    }
  }

  if (path.startsWith(".omp/tools/_lib/analytics/views/")) {
    return {
      category: "schema",
      importance: "authority_critical",
      inclusion_status: "included",
      parse_status: "parsed",
      language: "sql",
    }
  }

  if (path.startsWith(".omp/tools/_lib/analytics/")) {
    return {
      category: "duckdb_projection",
      importance: "authority_critical",
      inclusion_status: "included",
      parse_status: isTextLikePath(path) ? "parsed" : "not_source",
      language: isTextLikePath(path) ? (ext === ".sql" ? "sql" : "ts") : undefined,
    }
  }

  if (path.startsWith(".omp/tools/_lib/adapters/")) {
    return {
      category: "package_source",
      importance: "authority_critical",
      inclusion_status: "included",
      parse_status: isTextLikePath(path) ? "parsed" : "not_source",
      language: ext === ".json" ? "json" : "ts",
    }
  }

  if (path.startsWith(".omp/tools/")) {
    return {
      category: "omp_tool",
      importance: "authority_critical",
      inclusion_status: "included",
      parse_status: isTextLikePath(path) ? "parsed" : "not_source",
      language: ext === ".json" ? "json" : "ts",
    }
  }

  if (path.startsWith("packages/")) {
    if (path.includes("/test/") || path.includes("/tests/") || base.endsWith(".test.ts") || base.endsWith(".test.tsx")) {
      return {
        category: "package_test",
        importance: "review_context",
        inclusion_status: isTextLikePath(path) ? "included" : "indexed_only",
        parse_status: isTextLikePath(path) ? "parsed" : "not_source",
        language: ext === ".json" ? "json" : ext === ".sql" ? "sql" : "ts",
      }
    }
    return {
      category: "package_source",
      importance: "review_context",
      inclusion_status: isTextLikePath(path) ? "included" : "indexed_only",
      parse_status: isTextLikePath(path) ? "parsed" : "not_source",
      language: ext === ".json" ? "json" : ext === ".sql" ? "sql" : "ts",
    }
  }

  if (path.startsWith("docs/adr/") || path.startsWith("docs/json/adrs/")) {
    return {
      category: "adr",
      importance: "review_context",
      inclusion_status: "included",
      parse_status: isTextLikePath(path) ? "parsed" : "not_source",
      language: ext === ".json" ? "json" : "md",
    }
  }

  if (path.startsWith("docs/json/omp/")) {
    return {
      category: "board_artifact",
      importance: "review_context",
      inclusion_status: "included",
      parse_status: ext === ".json" ? "parsed" : "not_source",
      language: ext === ".json" ? "json" : undefined,
    }
  }

  if (path.startsWith(".github/workflows/")) {
    return {
      category: "workflow",
      importance: "review_context",
      inclusion_status: "included",
      parse_status: ext === ".yml" || ext === ".yaml" ? "parsed" : "not_source",
      language: ext === ".yml" || ext === ".yaml" ? "yaml" : undefined,
    }
  }

  if (path.startsWith("scripts/") || path.startsWith("script/")) {
    return {
      category: "script",
      importance: "review_context",
      inclusion_status: "included",
      parse_status: isTextLikePath(path) ? "parsed" : "not_source",
      language: ext === ".json" ? "json" : ext === ".sql" ? "sql" : undefined,
    }
  }

  if (path.startsWith("infra/") || path.startsWith("nix/")) {
    return {
      category: "config",
      importance: "review_context",
      inclusion_status: "included",
      parse_status: isTextLikePath(path) ? "parsed" : "not_source",
      language: ext === ".json" ? "json" : ext === ".yaml" || ext === ".yml" ? "yaml" : ext === ".sql" ? "sql" : undefined,
    }
  }

  if (path.startsWith("schemas/")) {
    return {
      category: "schema",
      importance: "review_context",
      inclusion_status: "included",
      parse_status: isTextLikePath(path) ? "parsed" : "not_source",
      language: ext === ".sql" ? "sql" : ext === ".json" ? "json" : undefined,
    }
  }

  if (path.endsWith(".md") || path.endsWith(".mdx")) {
    return {
      category: "doc",
      importance: "background",
      inclusion_status: "included",
      parse_status: "parsed",
      language: "md",
    }
  }

  if (isAssetPath(path)) {
    return {
      category: "asset",
      importance: "low_signal",
      inclusion_status: "indexed_only",
      parse_status: "not_source",
    }
  }

  if (path === "package.json" || path.endsWith("/package.json") || path === "bun.lock" || path === "bunfig.toml" || path === "turbo.json" || path === "tsconfig.json" || path.startsWith("tsconfig.")) {
    return {
      category: "config",
      importance: "review_context",
      inclusion_status: "included",
      parse_status: "parsed",
      language: ext === ".json" ? "json" : ext === ".toml" ? "toml" : undefined,
    }
  }

  if (ext === ".json") {
    return {
      category: "config",
      importance: "review_context",
      inclusion_status: "included",
      parse_status: "parsed",
      language: "json",
    }
  }

  if (ext === ".sql") {
    return {
      category: "schema",
      importance: "review_context",
      inclusion_status: "included",
      parse_status: "parsed",
      language: "sql",
    }
  }

  if (isTextLikePath(path)) {
    return {
      category: "doc",
      importance: "background",
      inclusion_status: "included",
      parse_status: "parsed",
      language: ext.slice(1) || undefined,
    }
  }

  return {
    category: "background" as CodeFileCategoryV1,
    importance: "background",
    inclusion_status: "indexed_only",
    parse_status: "not_source",
  }
}
