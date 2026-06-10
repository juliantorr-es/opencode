import { builtinModules } from "node:module"
import { relative, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { realpathSync } from "node:fs"
import { parseSync } from "oxc-parser"
import { ResolverFactory } from "oxc-resolver"

export type SourceGraphImportKindV1 = "value" | "type_only" | "side_effect" | "dynamic" | "require" | "unknown"

export type SourceGraphResolutionStatusV1 =
  | "resolved_in_packet"
  | "resolved_not_embedded"
  | "external_package"
  | "builtin"
  | "ts_js_extension_remap"
  | "missing_source"
  | "missing_asset"
  | "missing_generated"
  | "missing_prompt_template"
  | "missing_route_target"
  | "unresolved"

export type SourceGraphImportV1 = {
  specifier: string
  import_kind: SourceGraphImportKindV1
  start_line: number
  end_line: number
  start_byte: number
  end_byte: number
  resolved_path?: string
  resolution_status: SourceGraphResolutionStatusV1
}

export type SourceGraphExportV1 = {
  name: string
  kind: string
  start_byte: number
  end_byte: number
  signature?: string
  is_type: boolean
}

export type SourceGraphAnalysisV1 = {
  parser: "oxc" | "fallback"
  parse_errors: number
  parse_error_messages: string[]
  imports: SourceGraphImportV1[]
  exports: SourceGraphExportV1[]
  dynamic_imports: string[]
  metrics: {
    parse_ms: number
    resolve_ms: number
    static_imports: number
    static_exports: number
    dynamic_imports: number
    import_metas: number
    type_only_edges: number
    side_effect_edges: number
    resolved_edges: number
    unresolved_edges: number
    resolved_not_embedded: number
    external_package: number
    builtin: number
    ts_js_extension_remap: number
    missing_source: number
    missing_asset: number
    missing_generated: number
    missing_prompt_template: number
    missing_route_target: number
    parse_failures: number
  }
}

const BUILTIN_SPECIFIERS = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) => `node:${specifier}`),
])

const RESOLVER_CACHE = new Map<string, ResolverFactory>()

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

function lineForOffset(text: string, offset: number): number {
  return normalize(text).slice(0, Math.max(0, offset)).split("\n").length
}

function trimQuotes(value: string): string {
  const match = value.match(/^(['"`])([\s\S]*)\1$/)
  return match ? match[2] ?? value : value
}

function extOf(path: string): string {
  const file = path.split("/").pop() ?? path
  const idx = file.lastIndexOf(".")
  return idx >= 0 ? file.slice(idx).toLowerCase() : ""
}

function isTsJsExtensionRemap(specifier: string, resolvedPath: string): boolean {
  if (!/\.(js|jsx|mjs|cjs)$/i.test(specifier)) return false
  return /\.(ts|tsx|mts|cts)$/i.test(resolvedPath)
}

function classifyUnresolvedSpecifier(specifier: string): SourceGraphResolutionStatusV1 {
  if (specifier.endsWith(".js") || specifier.endsWith(".jsx") || specifier.endsWith(".mjs") || specifier.endsWith(".cjs")) return "ts_js_extension_remap"
  const ext = extOf(specifier)
  if ([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".mp4", ".mov", ".webm", ".m4v", ".avi", ".mp3", ".wav", ".ogg"].includes(ext)) return "missing_asset"
  if ([".css", ".scss", ".sass"].includes(ext)) return "missing_asset"
  if (specifier.includes("/prompt/") || specifier.endsWith(".txt")) return "missing_prompt_template"
  if (specifier.includes("generated") || specifier.includes("/dist/") || specifier.includes("/types/") || specifier.endsWith(".d.ts")) return "missing_generated"
  if (specifier.includes("/route/") || specifier.includes("/routes/")) return "missing_route_target"
  return "missing_source"
}

function resolverForRepo(repoRoot: string): ResolverFactory {
  const existing = RESOLVER_CACHE.get(repoRoot)
  if (existing) return existing

  const resolver = new ResolverFactory({
    tsconfig: "auto",
    builtinModules: true,
    moduleType: true,
    conditionNames: ["node", "import", "require"],
    exportsFields: ["exports"],
    importsFields: ["imports"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"],
    mainFields: ["module", "main"],
    mainFiles: ["index"],
    modules: ["node_modules"],
    symlinks: true,
  })
  RESOLVER_CACHE.set(repoRoot, resolver)
  return resolver
}

function resolveEdge(args: {
  repoRoot: string
  importer: string
  specifier: string
  includedSet: Set<string>
}): { resolved_path?: string; resolution_status: SourceGraphResolutionStatusV1 } {
  if (BUILTIN_SPECIFIERS.has(args.specifier) || BUILTIN_SPECIFIERS.has(args.specifier.replace(/^node:/, ""))) {
    return { resolution_status: "builtin" }
  }

  const absImporter = resolve(args.repoRoot, args.importer)
  try {
    const result = resolverForRepo(args.repoRoot).resolveFileSync(absImporter, args.specifier)
    if (result.builtin) {
      return { resolution_status: "builtin", resolved_path: result.builtin.resolved }
    }
    if (result.path) {
      const rel = relative(realpathSync(args.repoRoot), realpathSync(result.path)).replace(/\\/g, "/")
      if (rel.startsWith("..")) return { resolution_status: "external_package", resolved_path: rel }
      if (isTsJsExtensionRemap(args.specifier, rel)) {
        return { resolution_status: "ts_js_extension_remap", resolved_path: rel }
      }
      return {
        resolved_path: rel,
        resolution_status: args.includedSet.has(rel) ? "resolved_in_packet" : "resolved_not_embedded",
      }
    }
  } catch {
    // Fall through to classifier below.
  }

  if (!args.specifier.startsWith(".") && !args.specifier.startsWith("/")) {
    return { resolution_status: "external_package" }
  }
  return { resolution_status: classifyUnresolvedSpecifier(args.specifier) }
}

function guessImportKind(entry: { entries: Array<{ isType: boolean }>; isDynamic?: boolean }): SourceGraphImportKindV1 {
  if (entry.isDynamic) return "dynamic"
  if (entry.entries.length === 0) return "side_effect"
  if (entry.entries.every((item) => item.isType)) return "type_only"
  return "value"
}

function buildSignature(text: string, start: number, end: number): string {
  return normalize(text).slice(start, end).replace(/\s+/g, " ").trim().slice(0, 240)
}

function oxcErrorMessages(errors: unknown[]): string[] {
  return errors.map((error) => {
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
    return String(error)
  }).filter(Boolean).slice(0, 10)
}

function thrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function parseRequireImports(sourceText: string): Array<{ specifier: string; start: number; end: number }> {
  const imports: Array<{ specifier: string; start: number; end: number }> = []
  const pattern = /require\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(sourceText)) !== null) {
    const specifier = match[2]
    if (!specifier) continue
    imports.push({
      specifier,
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return imports
}

export function analyzeSourceGraphFile(args: {
  path: string
  text: string
  repoRoot: string
  includedSet: Set<string>
}): SourceGraphAnalysisV1 {
  const started = performance.now()
  const normalized = normalize(args.text)
  const parseOptions: { lang: "js" | "ts" | "tsx"; sourceType: "unambiguous"; range: boolean; preserveParens: boolean } = {
    lang: args.path.endsWith(".tsx") ? "tsx" : args.path.endsWith(".ts") || args.path.endsWith(".mts") || args.path.endsWith(".cts") ? "ts" : "js",
    sourceType: "unambiguous" as const,
    range: true,
    preserveParens: true,
  }

  try {
    const result = parseSync(args.path, normalized, parseOptions)
    const parseMs = Math.max(0, Math.round(performance.now() - started))
    const resolveStarted = performance.now()
    const imports: SourceGraphImportV1[] = []
    const exports: SourceGraphExportV1[] = []

    for (const entry of result.module.staticImports) {
      const specifier = trimQuotes(entry.moduleRequest.value)
      const resolved = resolveEdge({
        repoRoot: args.repoRoot,
        importer: args.path,
        specifier,
        includedSet: args.includedSet,
      })
      imports.push({
        specifier,
        import_kind: guessImportKind(entry),
        start_line: lineForOffset(normalized, entry.start),
        end_line: lineForOffset(normalized, entry.end),
        start_byte: entry.start,
        end_byte: entry.end,
        ...resolved,
      })
    }

    for (const group of result.module.staticExports) {
      for (const entry of group.entries) {
        const specifier = entry.moduleRequest ? trimQuotes(entry.moduleRequest.value) : undefined
        if (specifier) {
          const resolved = resolveEdge({
            repoRoot: args.repoRoot,
            importer: args.path,
            specifier,
            includedSet: args.includedSet,
          })
          imports.push({
            specifier,
            import_kind: entry.isType ? "type_only" : "value",
            start_line: lineForOffset(normalized, entry.start),
            end_line: lineForOffset(normalized, entry.end),
            start_byte: entry.start,
            end_byte: entry.end,
            ...resolved,
          })
        }
        const exportName =
          entry.exportName.name ??
          entry.localName.name ??
          entry.importName.name ??
          (entry.exportName.kind === "Default" ? "default" : "export")
        exports.push({
          name: exportName,
          kind: entry.isType ? "type" : entry.importName.kind === "All" || entry.importName.kind === "AllButDefault" ? "re_export" : "export",
          start_byte: entry.start,
          end_byte: entry.end,
          signature: buildSignature(normalized, entry.start, entry.end),
          is_type: entry.isType,
        })
      }
    }

    const dynamicImports: string[] = []
    for (const entry of result.module.dynamicImports) {
      const specifier = trimQuotes(normalized.slice(entry.moduleRequest.start, entry.moduleRequest.end))
      dynamicImports.push(specifier)
      imports.push({
        specifier,
        import_kind: "dynamic",
        start_line: lineForOffset(normalized, entry.start),
        end_line: lineForOffset(normalized, entry.end),
        start_byte: entry.start,
        end_byte: entry.end,
        ...resolveEdge({
          repoRoot: args.repoRoot,
          importer: args.path,
          specifier,
          includedSet: args.includedSet,
        }),
      })
    }

    for (const entry of parseRequireImports(normalized)) {
      imports.push({
        specifier: entry.specifier,
        import_kind: "require",
        start_line: lineForOffset(normalized, entry.start),
        end_line: lineForOffset(normalized, entry.end),
        start_byte: entry.start,
        end_byte: entry.end,
        ...resolveEdge({
          repoRoot: args.repoRoot,
          importer: args.path,
          specifier: entry.specifier,
          includedSet: args.includedSet,
        }),
      })
    }

    const metrics = {
      parse_ms: parseMs,
      resolve_ms: Math.max(0, Math.round(performance.now() - resolveStarted)),
      static_imports: result.module.staticImports.length,
      static_exports: result.module.staticExports.length,
      dynamic_imports: result.module.dynamicImports.length,
      import_metas: result.module.importMetas.length,
      type_only_edges: imports.filter((item) => item.import_kind === "type_only").length,
      side_effect_edges: imports.filter((item) => item.import_kind === "side_effect").length,
      resolved_edges: imports.filter((item) => item.resolution_status === "resolved_in_packet" || item.resolution_status === "resolved_not_embedded").length,
      unresolved_edges: imports.filter((item) => item.resolution_status === "missing_source" || item.resolution_status === "missing_asset" || item.resolution_status === "missing_generated" || item.resolution_status === "missing_prompt_template" || item.resolution_status === "missing_route_target" || item.resolution_status === "unresolved").length,
      resolved_not_embedded: imports.filter((item) => item.resolution_status === "resolved_not_embedded").length,
      external_package: imports.filter((item) => item.resolution_status === "external_package").length,
      builtin: imports.filter((item) => item.resolution_status === "builtin").length,
      ts_js_extension_remap: imports.filter((item) => item.resolution_status === "ts_js_extension_remap").length,
      missing_source: imports.filter((item) => item.resolution_status === "missing_source").length,
      missing_asset: imports.filter((item) => item.resolution_status === "missing_asset").length,
      missing_generated: imports.filter((item) => item.resolution_status === "missing_generated").length,
      missing_prompt_template: imports.filter((item) => item.resolution_status === "missing_prompt_template").length,
      missing_route_target: imports.filter((item) => item.resolution_status === "missing_route_target").length,
      parse_failures: 0,
    }

    return {
      parser: "oxc",
      parse_errors: result.errors.length,
      parse_error_messages: oxcErrorMessages(result.errors),
      imports,
      exports,
      dynamic_imports: dynamicImports,
      metrics,
    }
  } catch (error) {
    const parseMs = Math.max(0, Math.round(performance.now() - started))
    const dynamicImports = [...normalized.matchAll(/import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((match) => match[1]!).filter(Boolean)
    const requireImports = parseRequireImports(normalized).map((entry) => entry.specifier)
    const imports = [...dynamicImports, ...requireImports].map((specifier, index) => ({
      specifier,
      import_kind: (dynamicImports.includes(specifier) ? "dynamic" : "require") as "dynamic" | "require",
      start_line: 1,
      end_line: 1,
      start_byte: index,
      end_byte: index,
      resolution_status: classifyUnresolvedSpecifier(specifier),
    }))
    return {
      parser: "fallback",
      parse_errors: 1,
      parse_error_messages: [thrownMessage(error)].filter(Boolean).slice(0, 10),
      imports,
      exports: [],
      dynamic_imports: dynamicImports,
      metrics: {
        parse_ms: parseMs,
        resolve_ms: 0,
        static_imports: 0,
        static_exports: 0,
        dynamic_imports: dynamicImports.length,
        import_metas: 0,
        type_only_edges: 0,
        side_effect_edges: 0,
        resolved_edges: 0,
        unresolved_edges: imports.length,
        resolved_not_embedded: 0,
        external_package: 0,
        builtin: 0,
        ts_js_extension_remap: 0,
        missing_source: imports.length,
        missing_asset: 0,
        missing_generated: 0,
        missing_prompt_template: 0,
        missing_route_target: 0,
        parse_failures: 1,
      },
    }
  }
}
