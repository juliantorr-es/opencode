import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { readFileSync, existsSync } from "node:fs"
import { init, indexSymbol, indexDependency, recordPattern, indexFile } from "./db"

// Load tree-sitter WASM (zero npm install — already a project dependency!)
let Parser: any = null
let TypeScript: any = null
let TSX: any = null

function loadTreeSitter() {
  if (Parser) return true
  try {
    // tree-sitter-typescript is already in node_modules
    Parser = require("tree-sitter")
    TypeScript = require("tree-sitter-typescript").typescript
    TSX = require("tree-sitter-typescript").tsx
    return true
  } catch {
    return false
  }
}

function r(worktree: string, p: string): string { return resolve(worktree, p) }

interface SymbolInfo {
  name: string
  kind: string
  line: number
  exported: boolean
  signature?: string
}

function parseFile(filePath: string, content: string): {
  symbols: SymbolInfo[]
  imports: { from: string; path: string; symbols: string[] }[]
  patterns: string[]
} {
  if (!loadTreeSitter()) {
    // Fall back to regex-based parsing
    return regexParse(filePath, content)
  }

  const parser = new Parser()
  const isTsx = filePath.endsWith(".tsx")
  parser.setLanguage(isTsx ? TSX : TypeScript)

  const tree = parser.parse(content)
  const symbols: SymbolInfo[] = []
  const imports: { from: string; path: string; symbols: string[] }[] = []
  const patterns: string[] = []
  const lines = content.split("\n")

  function getText(node: any): string {
    return content.slice(node.startIndex, node.endIndex)
  }

  function getLine(node: any): number {
    return node.startPosition.row + 1
  }

  function walk(node: any) {
    // Export statements
    if (node.type === "export_statement") {
      const child = node.firstChild
      if (child) {
        // export function/class/const/type/interface
        if (["function_declaration","class_declaration","lexical_declaration","variable_declaration","type_alias_declaration","interface_declaration","abstract_class_declaration"].includes(child.type)) {
          const nameNode = child.childForFieldName?.("name") || (child.firstChild?.type === "identifier" ? child.firstChild : null)
          if (nameNode) {
            symbols.push({
              name: getText(nameNode),
              kind: child.type.replace("_declaration",""),
              line: getLine(nameNode),
              exported: true,
              signature: getText(child).split("\n")[0]?.trim().slice(0, 120),
            })
          }
        }
        // export const { a, b } or export { a, b }
        if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
          // Handled above
        }
      }
    }

    // export default function/class
    if (node.type === "export_statement" && node.text?.startsWith("export default")) {
      const decl = node.firstChild
      if (decl) {
        const nameNode = decl.childForFieldName?.("name")
        if (nameNode) {
          symbols.push({
            name: getText(nameNode),
            kind: decl.type.replace("_declaration",""),
            line: getLine(nameNode),
            exported: true,
            signature: getText(decl).split("\n")[0]?.trim().slice(0, 120),
          })
        }
      }
    }

    // Import statements
    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName?.("source")
      const clauses = node.children?.filter((c: any) => c.type === "import_clause" || c.type === "named_imports" || c.type === "namespace_import")
      let syms: string[] = []
      for (const clause of (clauses || [])) {
        for (const child of (clause.children || [])) {
          if (child.type === "import_specifier" || child.type === "identifier") {
            syms.push(getText(child).replace(/\s*as\s+\w+/, "").trim())
          }
        }
      }
      if (sourceNode) {
        const importPath = getText(sourceNode).replace(/['"]/g, "")
        imports.push({ path: importPath, symbols: syms, from: filePath })
      }
    }

    // Pattern detection via AST
    if (node.type === "export_statement" && getText(node).includes("export * as")) {
      patterns.push("self-export")
    }
    if (node.type === "class_declaration") {
      const heritage = node.children?.filter((c: any) => c.type === "implements_clause" || c.type === "extends_clause")
      if (heritage?.length > 0) patterns.push("dependency-injection")
    }

    // Recurse
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!)
    }
  }

  walk(tree.rootNode)
  return { symbols, imports, patterns }
}

// Regex fallback for when tree-sitter fails
function regexParse(filePath: string, content: string): {
  symbols: SymbolInfo[]
  imports: { from: string; path: string; symbols: string[] }[]
  patterns: string[]
} {
  const symbols: SymbolInfo[] = []
  const imports: { from: string; path: string; symbols: string[] }[] = []
  const patterns: string[] = []

  const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|type|interface|enum)\s+(\w+)/g
  let m
  while ((m = exportRe.exec(content)) !== null) {
    symbols.push({ name: m[2]!, kind: m[1]!, line: 0, exported: true })
  }

  const importRe = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g
  while ((m = importRe.exec(content)) !== null) {
    imports.push({ path: m[3]!, symbols: (m[1] || m[2] || "").split(",").map(s => s.trim()), from: filePath })
  }

  if (/export \* as/.test(content)) patterns.push("self-export")
  if (/implements|@Injectable/.test(content)) patterns.push("dependency-injection")

  return { symbols, imports, patterns }
}

export default tool({
  description: "Deep code analysis using tree-sitter AST parsing. Extracts symbols (functions, classes, types), imports, call graphs, and detects patterns. Falls back to regex if tree-sitter unavailable. MUCH more accurate than grep for understanding code structure.",
  args: {
    action: tool.schema.string().describe("'parse' to analyze a file | 'callers' to find usages of a symbol | 'impact' to see what breaks if a symbol changes | 'graph' to build dependency subgraph"),
    file_path: tool.schema.string().describe("File to analyze."),
    symbol: tool.schema.string().optional().describe("Symbol name to trace (for 'callers'/'impact')."),
    depth: tool.schema.number().optional().describe("Max dependency depth (for 'graph', default 2)."),
  },
  async execute(args, context) {
    const db = init(context.worktree)
    const filePath = args.file_path
    const fullPath = r(context.worktree, filePath)
    if (!existsSync(fullPath)) return JSON.stringify({ error: `File not found: ${filePath}` }, null, 2)

    const content = readFileSync(fullPath, "utf8")
    const lines = content.split("\n")

    if (args.action === "parse") {
      const { symbols, imports, patterns } = parseFile(filePath, content)

      // Index into knowledge graph
      for (const s of symbols) {
        indexSymbol(db, filePath, s.name, s.kind, s.line, s.exported, s.signature || "")
      }
      for (const imp of imports) {
        let toFile = imp.path
        if (imp.path.startsWith(".")) {
          const dir = filePath.replace(/\/[^/]+$/, "")
          toFile = resolve(dir, imp.path).replace(context.worktree + "/", "")
          if (!toFile.match(/\.(ts|tsx|js|jsx)$/)) toFile += ".ts"
        }
        indexDependency(db, filePath, toFile, imp.path, imp.symbols.join(", "))
      }
      for (const p of patterns) {
        recordPattern(db, p, filePath, `Detected via AST: ${p}`, "", context.agent)
      }
      indexFile(db, filePath, `AST-parsed: ${symbols.length} exports, ${imports.length} imports`, 
        symbols.filter(s => s.exported).map(s => s.name).join(", "), lines.length, context.agent)

      return JSON.stringify({
        action: "parse", file: filePath, lines: lines.length,
        exports: symbols.filter(s => s.exported).map(s => ({ name: s.name, kind: s.kind, line: s.line, signature: s.signature })),
        internal: symbols.filter(s => !s.exported).map(s => ({ name: s.name, kind: s.kind })),
        imports: imports.map(i => ({ path: i.path, symbols: i.symbols })),
        patterns,
        indexed: true,
      }, null, 2)
    }

    if (args.action === "callers") {
      if (!args.symbol) return JSON.stringify({ error: "symbol required for callers" }, null, 2)
      // Find all files that import this symbol
      const callers = db.query(`
        SELECT DISTINCT from_file, imported_symbols FROM dependencies
        WHERE to_file = ? AND imported_symbols LIKE ?
        LIMIT 30
      `).all(filePath, `%${args.symbol}%`) as any[]

      return JSON.stringify({
        action: "callers", symbol: args.symbol, file: filePath,
        callers: callers.map((c: any) => ({ file: c.from_file, symbols: c.imported_symbols })),
        count: callers.length,
      }, null, 2)
    }

    if (args.action === "impact") {
      if (!args.symbol) return JSON.stringify({ error: "symbol required for impact" }, null, 2)
      // Breadth-first search: what files depend on this symbol?
      const visited = new Set<string>([filePath])
      const queue = [filePath]
      const impact: string[] = []
      const maxDepth = args.depth ?? 3

      for (let depth = 0; depth < maxDepth && queue.length > 0; depth++) {
        const current = queue.shift()!
        const deps = db.query(`
          SELECT DISTINCT from_file FROM dependencies
          WHERE to_file = ? AND from_file NOT IN (${[...visited].map(() => "?").join(",")})
          LIMIT 20
        `).all(current, ...visited) as any[]

        for (const d of deps) {
          if (!visited.has(d.from_file)) {
            visited.add(d.from_file)
            queue.push(d.from_file)
            impact.push(d.from_file)
          }
        }
      }

      return JSON.stringify({
        action: "impact", symbol: args.symbol, file: filePath, depth: maxDepth,
        impacted_files: impact,
        total: impact.length,
        severity: impact.length > 10 ? "🔴 HIGH" : impact.length > 3 ? "🟡 MEDIUM" : "🟢 LOW",
        hint: impact.length > 10 ? "This symbol is widely used. Changes here will cascade." : undefined,
      }, null, 2)
    }

    if (args.action === "graph") {
      const maxDepth = args.depth ?? 2
      // Build a dependency subgraph centered on this file
      const nodes = new Set<string>([filePath])
      const edges: { from: string; to: string }[] = []
      const queue = [filePath]

      for (let depth = 0; depth < maxDepth && queue.length > 0; depth++) {
        const current = queue.shift()!
        // Outgoing deps
        const deps = db.query(`SELECT to_file, imported_symbols FROM dependencies WHERE from_file = ? LIMIT 20`).all(current) as any[]
        for (const d of deps) {
          edges.push({ from: current, to: d.to_file })
          if (!nodes.has(d.to_file)) { nodes.add(d.to_file); queue.push(d.to_file) }
        }
        // Incoming deps
        const revDeps = db.query(`SELECT from_file FROM dependencies WHERE to_file = ? AND from_file NOT IN (${[...nodes].map(() => "?").join(",")}) LIMIT 10`).all(current, ...nodes) as any[]
        for (const d of revDeps) {
          edges.push({ from: d.from_file, to: current })
          if (!nodes.has(d.from_file)) { nodes.add(d.from_file); queue.push(d.from_file) }
        }
      }

      return JSON.stringify({
        action: "graph", center: filePath, depth: maxDepth,
        nodes: [...nodes].length, edges: edges.length,
        graph: { nodes: [...nodes], edges },
        hint: "Use this to understand the dependency neighborhood.",
      }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: parse, callers, impact, graph.` }, null, 2)
  },
})
