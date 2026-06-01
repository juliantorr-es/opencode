import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

// Tree-sitter AST for precise focus extraction
let tsReady = false, ParserCtor: any, tsLang: any, tsxLang: any
async function ensureTs(worktree: string) {
  if (tsReady) return
  const wtPath = resolve(worktree, "node_modules/web-tree-sitter"); const T = await import(wtPath)
  await T.default.init()
  const base = resolve(worktree, "node_modules/tree-sitter-typescript")
  tsLang = await T.default.Language.load(resolve(base, "tree-sitter-typescript.wasm"))
  tsxLang = await T.default.Language.load(resolve(base, "tree-sitter-tsx.wasm"))
  ParserCtor = T.default
  tsReady = true
}

function artifactLog(context: any, event: Record<string, unknown>) {
  try {
    const dir = resolve(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/artifacts`)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(resolve(dir, `${context.sessionID}.v1.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8")
  } catch (_) {}
}

function astFocus(source: string, name: string, filePath: string): { start: number; end: number } | null {
  const lang = filePath.endsWith(".tsx") ? tsxLang : tsLang
  const parser = new ParserCtor()
  parser.setLanguage(lang)
  const tree = parser.parse(source)
  const cursor = tree.walk()

  const targetTypes = ["function_declaration", "method_definition", "arrow_function", "class_declaration",
    "interface_declaration", "type_alias_declaration", "lexical_declaration", "variable_declaration", "export_statement"]

  let result: { start: number; end: number } | null = null
  const visit = () => {
    const node = cursor.currentNode()
    if (result) return
    if (targetTypes.includes(node.type)) {
      const nameNode = node.childForFieldName?.("name") ?? node.namedChildren?.find((c: any) => c.type === "identifier")
      if (nameNode && source.slice(nameNode.startIndex, nameNode.endIndex) === name) {
        result = { start: node.startIndex, end: node.endIndex }
      }
    }
    if (!result && cursor.gotoFirstChild()) { visit(); cursor.gotoParent() }
    if (!result && cursor.gotoNextSibling()) visit()
  }
  visit()
  return result
}

export default tool({
  description: "Read a source file and return a structured digest — imports, exports, key symbols, and optional focus on a specific symbol.",
  args: {
    file: tool.schema.string().describe("Path to the source file"),
    focus: tool.schema.string().optional().describe("Function name, class name, or symbol to focus on. Returns only the relevant section + imports."),
    summary_only: tool.schema.boolean().optional().describe("Return a 10-line overview: imports, exports, top-level symbols."),
    include_imports: tool.schema.boolean().optional().describe("Always include the import block at the top (default true)"),
  },
  async execute(args, context) {
    const path = resolvePath(context.worktree, args.file)
    if (!existsSync(path)) return JSON.stringify({ status: "not_found", path: args.file }, null, 2)

    const content = readFileSync(path, "utf8")
    const lines = content.split("\n")
    const maxLines = args.summary_only ? 60 : 300

    // Extract imports
    const imports: { line: number; text: string }[] = []
    let importStarted = false, importEnded = false
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i]!.trim()
      if (/^(import|from)\s/.test(s)) { imports.push({ line: i + 1, text: s }); importStarted = true }
      else if (importStarted && s === "" && imports.length > 0) importEnded = true
      else if (importStarted && importEnded && s !== "") break
    }

    // Extract exports
    const exports: { line: number; text: string }[] = []
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i]!.trim()
      if (/^export\s+(const|function|class|interface|type|default|async)/.test(s) || /^export\s+\{/.test(s)) {
        exports.push({ line: i + 1, text: s.slice(0, 120) })
      }
    }

    // Extract top-level symbols
    const symbols: { line: number; name: string; kind: string; text: string }[] = []
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i]!.trim()
      let m: RegExpMatchArray | null
      m = s.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
      if (m) { symbols.push({ line: i + 1, name: m[1]!, kind: "function", text: s.slice(0, 120) }); continue }
      m = s.match(/^(?:export\s+)?class\s+(\w+)/)
      if (m) { symbols.push({ line: i + 1, name: m[1]!, kind: "class", text: s.slice(0, 120) }); continue }
      m = s.match(/^(?:export\s+)?(?:interface|type)\s+(\w+)/)
      if (m) { symbols.push({ line: i + 1, name: m[1]!, kind: "type", text: s.slice(0, 120) }); continue }
      m = s.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?[\(\function]/)
      if (m) { symbols.push({ line: i + 1, name: m[1]!, kind: "const_fn", text: s.slice(0, 120) }); continue }
    }

    // Focus mode: use tree-sitter AST for precise extraction, fall back to regex+braces
    let focusedSection: string | null = null
    let focusMethod = "regex"
    if (args.focus) {
      try {
        await ensureTs(context.worktree)
        const range = astFocus(content, args.focus, args.file)
        if (range) {
          const section = content.slice(range.start, range.end)
          const importBlock = imports.map(i => i.text).join("\n")
          const startLine = content.slice(0, range.start).split("\n").length
          const endLine = startLine + section.split("\n").length - 1
          focusedSection = `${importBlock}\n\n// --- ${args.focus} (lines ${startLine}-${endLine}, AST) ---\n${section}`
          focusMethod = "tree-sitter AST"
        }
      } catch (_) {}

      // Fall back to regex + brace counting
      if (!focusedSection) {
      const sym = symbols.find(s => s.name === args.focus) || symbols.find(s => s.name.toLowerCase() === args.focus.toLowerCase())
      if (sym) {
        const start = sym.line - 1
        let end = start
        // Find closing brace by tracking brace depth
        let depth = 0, started = false
        for (let j = start; j < lines.length; j++) {
          const line = lines[j]!
          for (const ch of line) {
            if (ch === "{") { depth++; started = true }
            if (ch === "}") { depth-- }
          }
          if (started && depth === 0) { end = j; break }
          if (j > start + 500) { end = j; break } // safety limit
        }
        const importBlock = imports.map(i => i.text).join("\n")
        const section = lines.slice(start, end + 1).join("\n")
        focusedSection = `${importBlock}\n\n// --- ${args.focus} (lines ${start + 1}-${end + 1}) ---\n${section}`
      }
    }
  }

    const output: Record<string, unknown> = {
      file: args.file,
      lines: lines.length,
    }

    if (args.summary_only) {
      output.overview = `${lines.length} lines, ${imports.length} imports, ${exports.length} exports, ${symbols.length} top-level symbols`
      output.imports = imports.slice(0, 20).map(i => i.text)
      output.exports = exports.slice(0, 10).map(e => e.text)
      output.symbols = symbols.slice(0, 15).map(s => `${s.kind} ${s.name} (line ${s.line})`)
    } else if (focusedSection) {
      output.focus = args.focus
      output.content = focusedSection.slice(0, 3000)
    } else {
      output.overview = `${lines.length} lines, ${imports.length} imports, ${exports.length} exports`
      output.imports = imports.slice(0, 20).map(i => i.text)
      output.exports = exports.slice(0, 10).map(e => e.text)
      output.symbols = symbols.slice(0, 20).map(s => ({ name: s.name, kind: s.kind, line: s.line }))
      if (lines.length <= maxLines) {
        output.content = content
      } else {
        output.content = lines.slice(0, 25).join("\n") + `\n... (${lines.length - 50} lines omitted) ...\n` + lines.slice(-25).join("\n")
      }
    }

    // Strip large raw content to avoid overwhelming
    artifactLog(context, { tool: "read_source", action: "read", file: args.file, lines: lines.length })
    return JSON.stringify(output, null, 2)
  },
})
