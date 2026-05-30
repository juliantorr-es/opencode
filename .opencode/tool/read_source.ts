import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

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

    // Focus mode
    let focusedSection: string | null = null
    if (args.focus) {
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
          if (j > start + 100) { end = j; break } // safety limit
        }
        const importBlock = imports.map(i => i.text).join("\n")
        const section = lines.slice(start, end + 1).join("\n")
        focusedSection = `${importBlock}\n\n// --- ${args.focus} (lines ${start + 1}-${end + 1}) ---\n${section}`
      }
    }

    const output: Record<string, unknown> = {
      file: args.file,
      total_lines: lines.length,
      import_count: imports.length,
      export_count: exports.length,
      symbol_count: symbols.length,
    }

    if (args.summary_only) {
      output.imports = imports.slice(0, 20).map(i => i.text)
      output.exports = exports.slice(0, 10).map(e => `${e.line}: ${e.text}`)
      output.symbols = symbols.slice(0, 15).map(s => `${s.kind} ${s.name} (line ${s.line})`)
    } else if (focusedSection) {
      output.focused = args.focus
      output.content = focusedSection.slice(0, 3000)
    } else {
      output.imports = imports.slice(0, 20)
      output.exports = exports.slice(0, 10)
      output.symbols = symbols
      if (lines.length <= maxLines) {
        output.content = content
      } else {
        output.content_head = lines.slice(0, 20).join("\n")
        output.content_tail = lines.slice(-20).join("\n")
        output.content_truncated = lines.length
      }
    }

    // Strip large raw content to avoid overwhelming
    return JSON.stringify(output, null, 2)
  },
})
