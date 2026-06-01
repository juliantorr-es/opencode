import { tool } from "@opencode-ai/plugin"
import { init, indexFile, indexSymbol, indexDependency, recordPattern, recordConvention, fileKnowledge, findRelated } from "./db"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

function r(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Index the codebase into the knowledge graph. Call this when you discover files, symbols, patterns, or conventions. The context engine uses this to enrich future agents.",
  args: {
    action: tool.schema.string().describe("'file' | 'symbol' | 'dependency' | 'pattern' | 'convention' | 'query' | 'auto_index'"),
    file_path: tool.schema.string().optional().describe("File path relative to worktree."),
    purpose: tool.schema.string().optional().describe("What this file does (for 'file' action)."),
    exports: tool.schema.string().optional().describe("Comma-separated list of exported symbols (for 'file')."),
    symbol_name: tool.schema.string().optional().describe("Symbol name (for 'symbol')."),
    symbol_kind: tool.schema.string().optional().describe("function | class | type | interface | const | enum (for 'symbol')."),
    symbol_line: tool.schema.number().optional().describe("Line number (for 'symbol')."),
    exported: tool.schema.boolean().optional().describe("Is it exported? (for 'symbol')."),
    signature: tool.schema.string().optional().describe("Function/class signature (for 'symbol')."),
    from_file: tool.schema.string().optional().describe("Importing file (for 'dependency')."),
    to_file: tool.schema.string().optional().describe("Imported file (for 'dependency')."),
    import_path: tool.schema.string().optional().describe("The import path string (for 'dependency')."),
    imported_symbols: tool.schema.string().optional().describe("Comma-separated imported symbols (for 'dependency')."),
    pattern_name: tool.schema.string().optional().describe("Pattern name: self-export, dependency-injection, etc. (for 'pattern'/'convention')."),
    description: tool.schema.string().optional().describe("Description of the pattern/convention."),
    example: tool.schema.string().optional().describe("Example code snippet."),
    category: tool.schema.string().optional().describe("Convention category: naming, imports, testing, structure (for 'convention')."),
    query: tool.schema.string().optional().describe("Concept to search for (for 'query' action)."),
  },
  async execute(args, context) {
    const db = init(context.worktree)

    if (args.action === "file") {
      if (!args.file_path) return JSON.stringify({ error: "file_path required" }, null, 2)
      // Auto-detect line count if file exists
      let lineCount = 0
      const fullPath = r(context.worktree, args.file_path)
      if (existsSync(fullPath)) {
        try { lineCount = readFileSync(fullPath, "utf8").split("\n").length } catch {}
      }
      indexFile(db, args.file_path, args.purpose || "", args.exports || "", lineCount, context.agent)
      return JSON.stringify({ status: "indexed", action: "file", path: args.file_path, line_count: lineCount }, null, 2)
    }

    if (args.action === "symbol") {
      if (!args.file_path || !args.symbol_name || !args.symbol_kind) return JSON.stringify({ error: "file_path, symbol_name, symbol_kind required" }, null, 2)
      indexSymbol(db, args.file_path, args.symbol_name, args.symbol_kind, args.symbol_line || 0, args.exported || false, args.signature || "")
      return JSON.stringify({ status: "indexed", action: "symbol", name: args.symbol_name, kind: args.symbol_kind }, null, 2)
    }

    if (args.action === "dependency") {
      if (!args.from_file || !args.to_file) return JSON.stringify({ error: "from_file, to_file required" }, null, 2)
      indexDependency(db, args.from_file, args.to_file, args.import_path || "", args.imported_symbols || "")
      return JSON.stringify({ status: "indexed", action: "dependency", from: args.from_file, to: args.to_file }, null, 2)
    }

    if (args.action === "pattern") {
      if (!args.pattern_name) return JSON.stringify({ error: "pattern_name required" }, null, 2)
      recordPattern(db, args.pattern_name, args.file_path || "", args.description || "", args.example || "", context.agent)
      return JSON.stringify({ status: "indexed", action: "pattern", name: args.pattern_name }, null, 2)
    }

    if (args.action === "convention") {
      if (!args.category || !args.pattern_name) return JSON.stringify({ error: "category, pattern_name required" }, null, 2)
      recordConvention(db, args.category, args.pattern_name, args.example || "", context.agent)
      return JSON.stringify({ status: "indexed", action: "convention", category: args.category, pattern: args.pattern_name }, null, 2)
    }

    if (args.action === "query") {
      if (!args.query) return JSON.stringify({ error: "query required" }, null, 2)
      const files = findRelated(db, args.query)
      if (files.length === 0) return JSON.stringify({ action: "query", query: args.query, files: [], hint: "No matches. Try a broader concept." }, null, 2)
      // Get file knowledge for top matches
      const results = files.slice(0, 10).map(f => {
        const k = fileKnowledge(db, f)
        return {
          file: f,
          purpose: k.file?.purpose || "?",
          exports: k.symbols?.filter((s: any) => s.exported).map((s: any) => s.name) || [],
          hotspot: k.hotspot ? `${k.hotspot.type_errors}T/${k.hotspot.test_failures}F` : null,
        }
      })
      return JSON.stringify({ action: "query", query: args.query, results, total_matches: files.length }, null, 2)
    }

    // Auto-index: scan a file and extract symbols + dependencies
    if (args.action === "auto_index") {
      if (!args.file_path) return JSON.stringify({ error: "file_path required" }, null, 2)
      const fullPath = r(context.worktree, args.file_path)
      if (!existsSync(fullPath)) return JSON.stringify({ error: `File not found: ${args.file_path}` }, null, 2)

      const content = readFileSync(fullPath, "utf8")
      const lines = content.split("\n")
      let indexed = { symbols: 0, deps: 0, patterns: 0 }

      // Extract exports
      const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|type|interface|enum)\s+(\w+)/g
      let m
      while ((m = exportRe.exec(content)) !== null) {
        indexSymbol(db, args.file_path, m[2]!, m[1]!, 0, true, "")
        indexed.symbols++
      }

      // Extract imports
      const importRe = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g
      while ((m = importRe.exec(content)) !== null) {
        const symbols = (m[1] || m[2] || "").replace(/\s+/g, " ").trim()
        const importPath = m[3]!
        // Resolve relative imports
        let toFile = importPath
        if (importPath.startsWith(".")) {
          const dir = args.file_path.replace(/\/[^/]+$/, "")
          toFile = resolve(dir, importPath).replace(context.worktree + "/", "")
          if (!toFile.endsWith(".ts") && !toFile.endsWith(".tsx")) toFile += ".ts"
        }
        indexDependency(db, args.file_path, toFile, importPath, symbols)
        indexed.deps++
      }

      // Detect patterns
      if (/export \* as/.test(content)) {
        recordPattern(db, "self-export", args.file_path, "Module uses self-export pattern: export * as Name from './module'", "", context.agent)
        indexed.patterns++
      }
      if (/class\s+\w+.*implements/.test(content) || /@Injectable/.test(content)) {
        recordPattern(db, "dependency-injection", args.file_path, "Class uses DI pattern (implements or @Injectable)", "", context.agent)
        indexed.patterns++
      }

      // Index the file itself
      indexFile(db, args.file_path, `Auto-indexed: ${indexed.symbols} exports, ${indexed.deps} imports`, 
        "", lines.length, context.agent)

      return JSON.stringify({ status: "auto_indexed", file: args.file_path, ...indexed, line_count: lines.length }, null, 2)
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: file, symbol, dependency, pattern, convention, query, auto_index.` }, null, 2)
  },
})
