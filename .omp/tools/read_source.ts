import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type WebTreeSitter from "web-tree-sitter";

interface TreeSitterParser {
  parse(source: string): TreeSitterTree
  setLanguage(lang: TreeSitterLanguage): void
}

interface TreeSitterTree {
  walk(): TreeSitterCursor
}

interface TreeSitterCursor {
  nodeType: string
  nodeText: string
  startIndex: number
  endIndex: number
  gotoFirstChild(): boolean
  gotoNextSibling(): boolean
  gotoParent(): boolean
}

interface TreeSitterLanguage {}

type ImportEntry = { line: number; text: string }
type ExportEntry = { line: number; text: string }
type SymbolEntry = { line: number; name: string; kind: string; text: string }

let tsReady = false
let ParserCtor: typeof WebTreeSitter | null = null
let tsLang: TreeSitterLanguage | null = null
let tsxLang: TreeSitterLanguage | null = null

async function ensureTs(worktree: string): Promise<void> {
  if (tsReady) return
  try {
    const webTreeSitter = await import("web-tree-sitter")
    await webTreeSitter.default.init()
    const base = resolve(worktree, "node_modules/tree-sitter-typescript")
    tsLang = await webTreeSitter.default.Language.load(resolve(base, "tree-sitter-typescript.wasm"))
    tsxLang = await webTreeSitter.default.Language.load(resolve(base, "tree-sitter-tsx.wasm"))
    ParserCtor = webTreeSitter.default
    tsReady = true
  } catch {
    // Tree-sitter is optional; regex fallback still provides structure.
  }
}

function artifactLog(
  pi: { cwd: string },
  ctx: { sessionId: string },
  event: Record<string, unknown>,
): void {
  try {
    const sessionId = ctx.sessionId || "unknown"
    const dir = resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/artifacts`)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(resolve(dir, `${sessionId}.v1.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8")
  } catch {
    // Non-critical telemetry.
  }
}

function extractImports(lines: string[]): ImportEntry[] {
  const imports: ImportEntry[] = []
  let importStarted = false
  let importEnded = false
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]!.trim()
    if (/^(import|from)\s/.test(s)) {
      imports.push({ line: i + 1, text: s })
      importStarted = true
    } else if (importStarted && s === "" && imports.length > 0) {
      importEnded = true
    } else if (importStarted && importEnded && s !== "") {
      break
    }
  }
  return imports
}

function extractExports(lines: string[]): ExportEntry[] {
  const exports: ExportEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]!.trim()
    if (/^export\s+(const|function|class|interface|type|default|async)/.test(s) || /^export\s+\{/.test(s)) {
      exports.push({ line: i + 1, text: s.slice(0, 120) })
    }
  }
  return exports
}

function extractSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]!.trim()
    let m: RegExpMatchArray | null
    m = s.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1]!, kind: "function", text: s.slice(0, 120) })
      continue
    }
    m = s.match(/^(?:export\s+)?class\s+(\w+)/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1]!, kind: "class", text: s.slice(0, 120) })
      continue
    }
    m = s.match(/^(?:export\s+)?(?:interface|type)\s+(\w+)/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1]!, kind: "type", text: s.slice(0, 120) })
      continue
    }
    m = s.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?[\(\{function]/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1]!, kind: "const_fn", text: s.slice(0, 120) })
    }
  }
  return symbols
}

function astFocus(source: string, name: string, filePath: string): { start: number; end: number } | null {
  if (!ParserCtor || !tsLang || !tsxLang) return null
  const lang = filePath.endsWith(".tsx") ? tsxLang : tsLang
  const parser = new ParserCtor() as unknown as TreeSitterParser
  parser.setLanguage(lang)
  const tree = parser.parse(source)
  const cursor = tree.walk()

  const targetTypes = [
    "function_declaration",
    "method_definition",
    "arrow_function",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "lexical_declaration",
    "variable_declaration",
    "export_statement",
  ]

  let result: { start: number; end: number } | null = null
  const visit = (): void => {
    if (cursor.gotoFirstChild()) {
      do {
        if (targetTypes.includes(cursor.nodeType) && !result) {
          const nodeText = cursor.nodeText
          const nameMatch = nodeText.match(/\b(\w+)\b/)
          if (nameMatch && nameMatch[1] === name) {
            result = { start: cursor.startIndex, end: cursor.endIndex }
          }
        }
        visit()
      } while (cursor.gotoNextSibling())
      cursor.gotoParent()
    }
  }

  visit()
  return result
}

function focusByBraceCounting(
  lines: string[],
  syms: SymbolEntry[],
  focusName: string,
  imports: ImportEntry[],
): string | null {
  const sym = syms.find((s) => s.name === focusName) ?? syms.find((s) => s.name.toLowerCase() === focusName.toLowerCase())
  if (!sym) return null

  const start = sym.line - 1
  let end = start
  let depth = 0
  let started = false

  for (let j = start; j < lines.length; j++) {
    const line = lines[j]!
    for (const ch of line) {
      if (ch === "{") {
        depth++
        started = true
      }
      if (ch === "}") depth--
    }
    if (started && depth === 0) {
      end = j
      break
    }
    if (j > start + 100) {
      end = j
      break
    }
  }

  const importBlock = imports.map((i) => i.text).join("\n")
  const section = lines.slice(start, end + 1).join("\n")
  return `${importBlock}\n\n// --- ${focusName} (lines ${start + 1}-${end + 1}) ---\n${section}`
}

const factory: CustomToolFactory = (pi) => ({
  name: "read_source",
  label: "Read Source",
  description:
    "Read a source file and return a structured digest: imports, exports, key symbols, and optional focus on a specific symbol. Uses tree-sitter AST for precise extraction when available, falls back to regex+brace counting.",
  parameters: pi.zod.object({
    file: pi.zod.string().describe("Path to the source file, relative to project root"),
    focus: pi.zod.string().optional().describe("Function name, class name, or symbol to focus on. Returns only the relevant section + imports."),
    summary_only: pi.zod.boolean().optional().describe("Return a compact overview of imports, exports, and top-level symbols."),
    include_imports: pi.zod.boolean().optional().describe("Always include the import block at the top (default true)"),
  }),
  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("read_source cancelled")

    onUpdate?.({
      content: [{ type: "text", text: `Reading ${params.file}...` }],
      details: { phase: "read", file: params.file },
    })

    const filePath = resolve(pi.cwd, params.file)
    if (!existsSync(filePath)) {
      return {
        content: [{ type: "text", text: `File not found: ${params.file}` }],
        details: { status: "not_found", path: params.file },
      }
    }

    const content = readFileSync(filePath, "utf8")
    const lines = content.split("\n")
    const imports = extractImports(lines)
    const exports = extractExports(lines)
    const symbols = extractSymbols(lines)

    let focusedSection: string | null = null
    let focusMethod = "none"

    if (params.focus) {
      try {
        await ensureTs(pi.cwd)
        const range = astFocus(content, params.focus, params.file)
        if (range) {
          const section = content.slice(range.start, range.end)
          const importBlock = params.include_imports === false ? "" : imports.map((i) => i.text).join("\n")
          const startLine = content.slice(0, range.start).split("\n").length
          const endLine = startLine + section.split("\n").length - 1
          focusedSection = `${importBlock ? `${importBlock}\n\n` : ""}// --- ${params.focus} (lines ${startLine}-${endLine}, AST) ---\n${section}`
          focusMethod = "tree-sitter AST"
        }
      } catch {
        // Ignore and fall back.
      }

      if (!focusedSection) {
        focusedSection = focusByBraceCounting(lines, symbols, params.focus, imports)
        if (focusedSection) focusMethod = "brace counting"
      }
    }

    const outputDetails: Record<string, unknown> = {
      file: params.file,
      lines: lines.length,
      imports_count: imports.length,
      exports_count: exports.length,
      symbols_count: symbols.length,
      focus_method: focusMethod,
    }

    const contentParts: Array<{ type: string; text: string }> = []

    if (params.summary_only) {
      outputDetails.overview = `${lines.length} lines, ${imports.length} imports, ${exports.length} exports, ${symbols.length} top-level symbols`
      outputDetails.imports = imports.slice(0, 20).map((i) => i.text)
      outputDetails.exports = exports.slice(0, 10).map((e) => e.text)
      outputDetails.symbols = symbols.slice(0, 15).map((s) => `${s.kind} ${s.name} (line ${s.line})`)

      contentParts.push({
        type: "text",
        text:
          `**${params.file}**: ${lines.length} lines, ${imports.length} imports, ${exports.length} exports, ${symbols.length} symbols\n\n` +
          `**Imports:**\n${imports.slice(0, 10).map((i) => `  ${i.text}`).join("\n")}\n\n` +
          `**Exports:**\n${exports.slice(0, 10).map((e) => `  ${e.text}`).join("\n")}\n\n` +
          `**Symbols:**\n${symbols.slice(0, 15).map((s) => `  ${s.kind} ${s.name} (line ${s.line})`).join("\n")}`,
      })
    } else if (focusedSection) {
      outputDetails.focus = params.focus
      outputDetails.focus_method = focusMethod
      contentParts.push({ type: "text", text: `// Focus: ${params.focus} (extracted via ${focusMethod})\n\n${focusedSection.slice(0, 3000)}` })
    } else {
      outputDetails.overview = `${lines.length} lines, ${imports.length} imports, ${exports.length} exports`
      outputDetails.imports = imports.slice(0, 20).map((i) => i.text)
      outputDetails.exports = exports.slice(0, 10).map((e) => e.text)
      outputDetails.symbols = symbols.slice(0, 20).map((s) => ({ name: s.name, kind: s.kind, line: s.line }))

      if (lines.length <= 300) {
        contentParts.push({ type: "text", text: content })
      } else {
        contentParts.push({
          type: "text",
          text: lines.slice(0, 25).join("\n") + `\n\n... (${lines.length - 50} lines omitted) ...\n\n` + lines.slice(-25).join("\n"),
        })
      }
    }

    artifactLog(pi, ctx, { tool: "read_source", action: "read", file: params.file, lines: lines.length })

    onUpdate?.({
      content: [{ type: "text", text: `Read complete: ${lines.length} lines` }],
      details: { phase: "complete", lines: lines.length, focus_method: focusMethod },
    })

    return {
      content: contentParts,
      details: outputDetails,
    }
  },
})

export default factory
