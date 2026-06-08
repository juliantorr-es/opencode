// Code Index Projection
// Builds a symbol index from repo files using tree-sitter.
// Symbols are stored as a projection table, rebuilt on demand.

import { Effect } from "effect"
import * as Database from "../db"
import { Parser, Language, type Node } from "web-tree-sitter"

import { fileURLToPath } from "url"
import { lazy } from "@/util/lazy"

// ── Types ─────────────────────────────────────────────

export interface CodeSymbol {
  id: string
  file: string
  name: string
  kind: string // "function" | "class" | "method" | "variable" | "import" | "export"
  line: number
  column: number
  parent_name?: string
  language: string
  project_root: string
}

// ── WASM path resolution ─────────────────────────────

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

// ── Lazy parser initialization ───────────────────────

// Grammar WASM files are loaded as data via Bun's WASM import syntax,
// not as code modules. Dynamic import is required for the WASM asset
// resolution to produce filesystem paths consumable by Language.load().
const parsers = lazy(async () => {
  // Init web-tree-sitter WASM runtime
  const { default: treeWasm } = await import(
    "web-tree-sitter/tree-sitter.wasm" as string,
    { with: { type: "wasm" } },
  )
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })

  // Load available grammar WASM files
  const { default: bashWasm } = await import(
    "tree-sitter-bash/tree-sitter-bash.wasm" as string,
    { with: { type: "wasm" } },
  )
  const { default: psWasm } = await import(
    "tree-sitter-powershell/tree-sitter-powershell.wasm" as string,
    { with: { type: "wasm" } },
  )

  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)

  const [bashLang, psLang] = await Promise.all([
    Language.load(bashPath),
    Language.load(psPath),
  ])

  const byLang: Record<string, Parser> = {}

  const bash = new Parser()
  bash.setLanguage(bashLang)
  byLang["bash"] = bash

  const ps = new Parser()
  ps.setLanguage(psLang)
  byLang["powershell"] = ps

  return byLang
})

// ── Language detection ─────────────────────────────────

function detectLanguage(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    sh: "bash",
    bash: "bash",
    ps1: "powershell",
  }
  return map[ext] ?? "unknown"
}

// ── Symbol extraction ─────────────────────────────────

const SYMBOL_KINDS = new Set([
  "function_declaration",
  "method_definition",
  "function",
  "class_declaration",
  "class",
  "import_statement",
  "import_declaration",
])

function kindForNodeType(type: string): "function" | "class" | "import" | null {
  if (type === "function_declaration" || type === "method_definition" || type === "function") {
    return "function"
  }
  if (type === "class_declaration" || type === "class") {
    return "class"
  }
  if (type === "import_statement" || type === "import_declaration") {
    return "import"
  }
  return null
}

function extractSymbols(
  node: Node,
  file: string,
  root: string,
  lang: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = []

  // Walk the tree recursively using child indices (avoids allocating
  // the children array for every node when most are not symbol-bearing).
  const walk = (n: Node, parent?: string): void => {
    const type = n.type
    if (n.isNamed && SYMBOL_KINDS.has(type)) {
      const kind = kindForNodeType(type)
      if (kind) {
        const nameNode = n.childForFieldName("name")
        const name = kind === "import"
          ? n.text.split("\n")[0]?.slice(0, 80) ?? "import"
          : nameNode?.text ?? type
        const pos = n.startPosition
        symbols.push({
          id: `${root}:${file}:${pos.row}`,
          file,
          name,
          kind,
          line: pos.row,
          column: pos.column,
          parent_name: kind === "function" ? parent : undefined,
          language: lang,
          project_root: root,
        })
      }
    }

    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i)
      if (child) walk(child, parent)
    }
  }

  walk(node)
  return symbols
}

// ── Storage helpers ───────────────────────────────────

function storeSymbols(symbols: CodeSymbol[]): void {
  const db = Database.Client() as any
  for (const s of symbols) {
    db.exec(
      `INSERT OR REPLACE INTO code_symbol_projection (id, file, name, kind, line, "column", parent_name, language, project_root) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        s.id,
        s.file,
        s.name,
        s.kind,
        s.line,
        s.column,
        s.parent_name ?? null,
        s.language,
        s.project_root,
      ],
    )
  }
}

function storeFallbackSymbols(
  root: string,
  file: string,
  content: string,
  lang: string,
): void {
  const db = Database.Client() as any
  const funcRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g
  const classRe = /(?:export\s+)?class\s+(\w+)/g
  let match: RegExpExecArray | null
  while ((match = funcRe.exec(content)) !== null) {
    db.exec(
      `INSERT OR REPLACE INTO code_symbol_projection (id, file, name, kind, line, "column", language, project_root) VALUES ($1,$2,$3,'function',0,0,$4,$5)`,
      [`${root}:${file}:fn:${match[1]}`, file, match[1], lang, root],
    )
  }
  while ((match = classRe.exec(content)) !== null) {
    db.exec(
      `INSERT OR REPLACE INTO code_symbol_projection (id, file, name, kind, line, "column", language, project_root) VALUES ($1,$2,$3,'class',0,0,$4,$5)`,
      [`${root}:${file}:class:${match[1]}`, file, match[1], lang, root],
    )
  }
}

// ── Projection ────────────────────────────────────────

export const codeIndexProjection = {
  name: "code_index",
  version: 1,

  ddl: `
    CREATE TABLE IF NOT EXISTS code_symbol_projection (
      id TEXT NOT NULL,
      file TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      "column" INTEGER NOT NULL,
      parent_name TEXT,
      language TEXT NOT NULL,
      project_root TEXT NOT NULL,
      PRIMARY KEY (id)
    )
  `,

  // Index a single file using tree-sitter.
  // Falls back to grep-based symbol extraction for unsupported languages.
  indexFile: (
    root: string,
    file: string,
    content: string,
  ): Effect.Effect<void> =>
    Effect.promise(async () => {
      const lang = detectLanguage(file)
      const byLang = await parsers()
      const parser = byLang[lang]

      if (!parser) {
        storeFallbackSymbols(root, file, content, lang)
        return
      }

      try {
        const tree = parser.parse(content)
        if (!tree) {
          storeFallbackSymbols(root, file, content, lang)
          return
        }
        const symbols = extractSymbols(tree.rootNode, file, root, lang)
        storeSymbols(symbols)
      } catch {
        storeFallbackSymbols(root, file, content, lang)
      }
    }),

  // Rebuild entire index for a project
  rebuild: (
    root: string,
    files: { path: string; content: string }[],
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const db = Database.Client() as any
      db.exec(`DELETE FROM code_symbol_projection WHERE project_root = $1`, [
        root,
      ])
      for (const f of files) {
        yield* codeIndexProjection.indexFile(root, f.path, f.content)
      }
    }),
}
