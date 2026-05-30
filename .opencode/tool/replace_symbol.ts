import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { readFileSync, writeFileSync, existsSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

let tsReady = false, ParserCtor: any, tsLang: any, tsxLang: any

async function ensureTs(worktree: string) {
  if (tsReady) return
  const wtPath = resolve(worktree, "node_modules/web-tree-sitter"); const T = await import(wtPath)
  await T.default.init()
  const tsWasm = resolve(worktree, "node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm")
  const tsxWasm = resolve(worktree, "node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm")
  tsLang = await T.default.Language.load(tsWasm)
  tsxLang = await T.default.Language.load(tsxWasm)
  ParserCtor = T.default
  tsReady = true
}

export default tool({
  description: "AST-aware symbol renaming. Replaces only real identifier references — skips strings, comments, and partial matches. Reports what was changed grouped by parent node type.",
  args: {
    file: tool.schema.string().describe("File to edit"),
    old_symbol: tool.schema.string().describe("Symbol to rename"),
    new_symbol: tool.schema.string().describe("Replacement symbol"),
    reason: tool.schema.string().describe("Why this replacement is needed"),
  },
  async execute(args, context) {
    const filePath = resolvePath(context.worktree, args.file)
    if (!existsSync(filePath)) return JSON.stringify({ status: "fail", error: `File not found: ${args.file}` }, null, 2)
    const source = readFileSync(filePath, "utf8")

    try {
      await ensureTs(context.worktree)
      const lang = args.file.endsWith(".tsx") ? tsxLang : tsLang
      const parser = new ParserCtor()
      parser.setLanguage(lang)
      const tree = parser.parse(source)

      const replacements: { start: number; end: number }[] = []
      const byType: Record<string, number> = {}
      const cursor = tree.walk()
      const idTypes = ["identifier", "property_identifier", "shorthand_property_identifier"]

      const visit = () => {
        const node = cursor.currentNode()
        if (idTypes.includes(node.type)) {
          if (source.slice(node.startIndex, node.endIndex) === args.old_symbol) {
            const pt = node.parent?.type || "unknown"
            if (!["string_fragment", "comment", "template_string"].includes(pt)) {
              replacements.push({ start: node.startIndex, end: node.endIndex })
              byType[pt] = (byType[pt] || 0) + 1
            }
          }
        }
        if (cursor.gotoFirstChild()) { visit(); cursor.gotoParent() }
        if (cursor.gotoNextSibling()) visit()
      }
      visit()

      if (replacements.length === 0) {
        const stringCount = source.split(args.old_symbol).length - 1
        if (stringCount === 0) return JSON.stringify({ status: "fail", error: "Symbol not found", hint: "AST scanned all identifiers — nothing matched." }, null, 2)
        return JSON.stringify({ status: "fail", error: `AST found 0 identifiers, but string search found ${stringCount}. The symbol only appears in strings/comments.`, hint: "AST correctly skipped non-identifier occurrences." }, null, 2)
      }

      let modified = source
      for (const r of replacements.sort((a, b) => b.start - a.start)) {
        modified = modified.slice(0, r.start) + args.new_symbol + modified.slice(r.end)
      }
      writeFileSync(filePath, modified, "utf8")

      const verify = readFileSync(filePath, "utf8")
      const vc = verify.split(args.new_symbol).length - 1
      if (vc < replacements.length) {
        return JSON.stringify({ status: "fail", error: `Write verification failed: expected ${replacements.length} replacements, found ${vc}` }, null, 2)
      }

      return JSON.stringify({
        status: "applied", file: args.file, ast_replacements: replacements.length,
        old_symbol: args.old_symbol, new_symbol: args.new_symbol,
        by_parent_type: byType, method: "tree-sitter AST",
        note: "Only real identifiers changed. Strings and comments skipped.",
      }, null, 2)
    } catch (e: any) {
      if (e?.message?.includes("tree-sitter") || e?.message?.includes("Cannot find")) {
        const count = source.split(args.old_symbol).length - 1
        if (count === 0) return JSON.stringify({ status: "fail", error: "Symbol not found" }, null, 2)
        writeFileSync(filePath, source.replaceAll(args.old_symbol, args.new_symbol), "utf8")
        return JSON.stringify({ status: "applied", file: args.file, occurrences: count, method: "string replace (AST unavailable)" }, null, 2)
      }
      return JSON.stringify({ status: "fail", error: e?.message || "error" }, null, 2)
    }
  },
})
