import { Context, Effect, Layer, Option, Ref } from "effect"
import path from "node:path"
import { createHash } from "node:crypto"
import { serviceUse } from "@opencode-ai/core/effect/service-use"

// ── FileContext ──────────────────────────────────────────────

export interface FileContext {
  path: string
  digest: string
  lastReadAt: number
  lastEditedAt?: number
  lastEditor?: string
  lastEditTool?: string
  lineCount: number
  language: string
  symbols: string[]
  imports: string[]
  exports: string[]
  knownTests: string[]
  riskTags: string[]
  isGenerated: boolean
  isProtected: boolean
  freshness: "fresh" | "stale" | "unknown"
  staleReason?: string
  summary?: string
}

// ── Service Interface ───────────────────────────────────────

export interface Interface {
  readonly get: (path: string) => Effect.Effect<Option.Option<FileContext>>
  readonly set: (path: string, ctx: FileContext) => Effect.Effect<void>
  readonly invalidate: (path: string, reason: string) => Effect.Effect<void>
  readonly refresh: (path: string, content: string) => Effect.Effect<FileContext>
  readonly getStale: (maxMs?: number) => Effect.Effect<string[]>
  readonly search: (query: string) => Effect.Effect<FileContext[]>
  readonly remove: (path: string) => Effect.Effect<void>
  readonly getAll: () => Effect.Effect<FileContext[]>
  readonly getByEditor: (actor: string) => Effect.Effect<FileContext[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileMemory") {}

export const use = serviceUse(Service)

// ── Language Map ────────────────────────────────────────────

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TSX",
  ".js": "JavaScript",
  ".jsx": "JSX",
  ".mjs": "ES Module JavaScript",
  ".cjs": "CommonJS JavaScript",
  ".mts": "ES Module TypeScript",
  ".cts": "CommonJS TypeScript",
  ".json": "JSON",
  ".jsonc": "JSONC",
  ".md": "Markdown",
  ".mdx": "MDX",
  ".py": "Python",
  ".rs": "Rust",
  ".css": "CSS",
  ".scss": "SCSS",
  ".sass": "Sass",
  ".less": "Less",
  ".html": "HTML",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".go": "Go",
  ".rb": "Ruby",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".c": "C",
  ".cpp": "C++",
  ".h": "C/C++ Header",
  ".hpp": "C++ Header",
  ".sql": "SQL",
  ".graphql": "GraphQL",
  ".gql": "GraphQL",
  ".proto": "Protocol Buffers",
  ".zig": "Zig",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".dart": "Dart",
  ".lua": "Lua",
  ".php": "PHP",
  ".cs": "C#",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".erl": "Erlang",
  ".hs": "Haskell",
  ".clj": "Clojure",
  ".cljs": "ClojureScript",
  ".nix": "Nix",
  ".tf": "Terraform",
  ".wasm": "WebAssembly",
}

function inferLanguage(path: string): string {
  for (const [ext, lang] of Object.entries(EXTENSION_LANGUAGE_MAP)) {
    if (path.endsWith(ext)) return lang
  }
  return "Unknown"
}

// ── Symbol / Import / Export Extraction ─────────────────────

function extractSymbols(content: string): string[] {
  const symbols = new Set<string>()

  // export const X, export async function x, export default class Foo, etc.
  const exportDecl = /export\s+(?:(?:default\s+)?(?:async\s+)?)?(?:const|function|class|type|interface|enum)\s+(\w+)/g
  for (const m of content.matchAll(exportDecl)) {
    if (m[1]) symbols.add(m[1])
  }

  // export * as Foo from "…"
  const exportStarAs = /export\s+\*\s+as\s+(\w+)\s+from/g
  for (const m of content.matchAll(exportStarAs)) {
    if (m[1]) symbols.add(m[1])
  }

  // export { Foo, Bar as Baz }
  const exportBrace = /export\s+\{([^}]+)\}/g
  for (const m of content.matchAll(exportBrace)) {
    for (const raw of m[1]!.split(",")) {
      const cleaned = raw.trim().replace(/^type\s+/, "")
      const name = cleaned.split(/\s+as\s+/).at(-1)!.trim()
      if (name) symbols.add(name)
    }
  }

  // Top-level class Foo, function foo, type Foo, interface Foo, enum Foo
  const topDecl = /^(?:abstract\s+)?(?:class|function|type|interface|enum)\s+(\w+)/gm
  for (const m of content.matchAll(topDecl)) {
    if (m[1]) symbols.add(m[1])
  }

  return [...symbols]
}

function extractImports(content: string): string[] {
  const imports = new Set<string>()

  // import X from "…", import { X } from "…", import * as X from "…", import type { X } from "…"
  const fromRegex = /import\s+(?:(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\w+))?)\s+from\s+["']([^"']+)["']/g
  for (const m of content.matchAll(fromRegex)) {
    if (m[1]) imports.add(m[1])
  }

  // Side-effect import "…"
  const sideEffect = /^import\s+["']([^"']+)["']/gm
  for (const m of content.matchAll(sideEffect)) {
    if (m[1]) imports.add(m[1])
  }

  return [...imports]
}

function extractExports(content: string): string[] {
  const exports = new Set<string>()

  // export const X, export function x, etc.
  const decl = /export\s+(?:(?:default\s+)?(?:async\s+)?)?(?:const|function|class|type|interface|enum)\s+(\w+)/g
  for (const m of content.matchAll(decl)) {
    if (m[1]) exports.add(m[1])
  }

  // export { X, Y as Z }
  const brace = /export\s+\{([^}]+)\}/g
  for (const m of content.matchAll(brace)) {
    for (const raw of m[1]!.split(",")) {
      const cleaned = raw.trim().replace(/^type\s+/, "")
      const name = cleaned.split(/\s+as\s+/).at(-1)!.trim()
      if (name) exports.add(name)
    }
  }

  // export * from "…" and export * as X from "…"
  const star = /export\s+(?:\*\s+as\s+\w+\s+from|\*\s+from)\s+["']([^"']+)["']/g
  for (const m of content.matchAll(star)) {
    if (m[1]) exports.add(`*:${m[1]}`)
  }

  return [...exports]
}

// ── Classification Helpers ─────────────────────────────────

function isGeneratedFile(filePath: string): boolean {
  if (filePath.includes("node_modules/")) return true
  const normalized = path.normalize(filePath)
  if (normalized.startsWith("dist/") || normalized.startsWith("out/") || normalized.startsWith(".build/")) return true
  if (normalized.includes("/dist/") || normalized.includes("/out/") || normalized.includes("/.build/")) return true
  if (/\.gen\.(ts|js|tsx|jsx)$/.test(normalized)) return true
  if (/\.generated\.(ts|js|tsx|jsx)$/.test(normalized)) return true
  return false
}

function isProtectedFile(filePath: string): boolean {
  const normalized = path.normalize(filePath)
  const basename = normalized.split("/").at(-1) ?? ""

  if (
    basename === "package-lock.json" ||
    basename === "yarn.lock" ||
    basename === "pnpm-lock.yaml" ||
    basename === "bun.lockb"
  ) {
    return true
  }

  if (basename === ".gitignore" || basename === ".editorconfig" || basename.startsWith(".env")) return true
  if (basename === "package.json" || basename === "tsconfig.json") return true

  if (normalized.endsWith(".wasm")) return true
  if (normalized.endsWith(".d.ts") || normalized.endsWith(".d.mts") || normalized.endsWith(".d.cts")) return true

  // Relative root patterns
  if (normalized.startsWith("node_modules/") || normalized.startsWith(".git/")) return true
  if (normalized.startsWith(".build/") || normalized.startsWith("dist/") || normalized.startsWith("out/")) return true

  // Absolute path variants
  if (normalized.includes("/node_modules/") || normalized.includes("/.git/")) return true
  if (normalized.includes("/.build/") || normalized.includes("/dist/") || normalized.includes("/out/")) return true

  return false
}

function computeRiskTags(path: string, isGenerated: boolean): string[] {
  const tags: string[] = []
  const basename = path.split("/").at(-1) ?? ""

  if (isGenerated) tags.push("generated")

  if (
    basename === "package.json" ||
    basename === "tsconfig.json" ||
    /\.config\.[a-z]+$/.test(basename) ||
    /^\.(?:eslint|prettier|editorconfig)/.test(basename) ||
    basename.startsWith(".env")
  ) {
    tags.push("config")
  }

  if (basename.includes("migration") || basename.includes("migrat") || path.includes("/migrations/")) {
    tags.push("migration")
  }

  if (
    basename === "package-lock.json" ||
    basename === "yarn.lock" ||
    basename === "pnpm-lock.yaml" ||
    basename === "bun.lockb"
  ) {
    tags.push("lockfile")
  }

  return tags
}

// ── Path Resolution Helper ────────────────────────────────

function normalizeProjectPath(root: string, p: string): string {
  if (path.isAbsolute(p)) return path.normalize(p)
  return path.resolve(root, p)
}

// ── Service Implementation ─────────────────────────────────

const make = Effect.gen(function* () {
  const projectRoot = process.cwd()
  const normalize = (p: string) => normalizeProjectPath(projectRoot, p)
  const state = yield* Ref.make(new Map<string, FileContext>())

  const set: Interface["set"] = (rawPath, ctx) =>
    Ref.update(state, (m) => {
      m.set(normalize(rawPath), ctx)
      return m
    })

  const invalidate: Interface["invalidate"] = (rawPath, reason) =>
    Ref.update(state, (m) => {
      const key = normalize(rawPath)
      const entry = m.get(key)
      if (entry) {
        m.set(key, { ...entry, freshness: "stale" as const, staleReason: reason })
      }
      return m
    })

  const refresh: Interface["refresh"] = (rawPath, content) =>
    Effect.gen(function* () {
      const key = normalize(rawPath)
      const digest = createHash("sha256").update(content).digest("hex")
      const now = Date.now()
      const language = inferLanguage(rawPath)
      const lineCount = content.split("\n").length
      const symbols = extractSymbols(content)
      const imports = extractImports(content)
      const exports = extractExports(content)
      const isGenerated = isGeneratedFile(rawPath)
      const isProtected = isProtectedFile(rawPath)
      const riskTags = computeRiskTags(rawPath, isGenerated)

      const ctx: FileContext = {
        path: rawPath,
        digest,
        lastReadAt: now,
        lineCount,
        language,
        symbols,
        imports,
        exports,
        knownTests: [],
        riskTags,
        isGenerated,
        isProtected,
        freshness: "fresh",
      }

      yield* set(key, ctx)
      return ctx
    })

  const get: Interface["get"] = (rawPath) =>
    Effect.gen(function* () {
      const key = normalize(rawPath)
      const map = yield* Ref.get(state)
      const entry = map.get(key)
      if (!entry) return Option.none()

      // Lazy refresh: for stale / unknown entries, try to read from disk
      if (entry.freshness !== "fresh") {
        const content: string | undefined = yield* Effect.tryPromise(() => Bun.file(key).text()).pipe(
          Effect.catch(() => Effect.succeed(undefined as string | undefined)),
        )
        if (content !== undefined) {
          yield* refresh(key, content)
          const updated = yield* Ref.get(state)
          return Option.some(updated.get(key) ?? entry)
        }
      }

      return Option.some(entry)
    })

  const getStale: Interface["getStale"] = (maxMs) =>
    Effect.gen(function* () {
      const now = Date.now()
      const threshold = maxMs !== undefined ? now - maxMs : now - 5 * 60 * 1000
      const map = yield* Ref.get(state)
      const result: string[] = []
      for (const [path, ctx] of map) {
        if (ctx.freshness !== "fresh" || ctx.lastReadAt < threshold) {
          result.push(path)
        }
      }
      return result
    })

  const search: Interface["search"] = (query) =>
    Effect.gen(function* () {
      const map = yield* Ref.get(state)
      const lower = query.toLowerCase()
      return [...map.values()].filter(
        (ctx) =>
          ctx.path.toLowerCase().includes(lower) ||
          ctx.symbols.some((s) => s.toLowerCase().includes(lower)) ||
          ctx.imports.some((i) => i.toLowerCase().includes(lower)) ||
          ctx.exports.some((e) => e.toLowerCase().includes(lower)) ||
          ctx.summary?.toLowerCase().includes(lower),
      )
    })

  const remove: Interface["remove"] = (rawPath) =>
    Ref.update(state, (m) => {
      m.delete(normalize(rawPath))
      return m
    })

  const getAll: Interface["getAll"] = () =>
    Effect.gen(function* () {
      const map = yield* Ref.get(state)
      return [...map.values()]
    })

  const getByEditor: Interface["getByEditor"] = (actor) =>
    Effect.gen(function* () {
      const map = yield* Ref.get(state)
      return [...map.values()].filter((ctx) => ctx.lastEditor === actor)
    })

  return Service.of({ get, set, invalidate, refresh, getStale, search, remove, getAll, getByEditor })
})

export const layer: Layer.Layer<Service> = Layer.effect(Service, make)
export const defaultLayer = layer

export const FileMemory = { Service, layer, defaultLayer } as const
