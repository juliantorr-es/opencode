import type { Language, Parser } from "web-tree-sitter"
import { ensureTreeSitterLanguages, languageForPath } from "./tree-sitter-languages.js"

export type TreeSitterDeclarationV1 = {
  name: string
  kind: string
  exported: boolean
  start_byte: number
  end_byte: number
  start_line: number
  end_line: number
}

function declarationName(node: import("web-tree-sitter").Node): string | null {
  const named = node.childForFieldName("name")
  if (named?.text) return named.text.trim()
  const text = node.text.trim()
  const match =
    text.match(/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/) ||
    text.match(/(?:export\s+)?class\s+([A-Za-z0-9_]+)/) ||
    text.match(/(?:export\s+)?interface\s+([A-Za-z0-9_]+)/) ||
    text.match(/(?:export\s+)?type\s+([A-Za-z0-9_]+)/) ||
    text.match(/(?:export\s+)?enum\s+([A-Za-z0-9_]+)/) ||
    text.match(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)/) ||
    text.match(/(?:export\s+)?method\s+([A-Za-z0-9_]+)/)
  return match?.[1] ?? null
}

function nodeRange(node: import("web-tree-sitter").Node): { start_byte: number; end_byte: number; start_line: number; end_line: number } {
  return {
    start_byte: node.startIndex,
    end_byte: node.endIndex,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
  }
}

function walkDeclarations(
  node: import("web-tree-sitter").Node,
  result: TreeSitterDeclarationV1[],
  exported = false,
): void {
  const nextExported = exported || node.type === "export_statement" || /^\s*export\s/m.test(node.text.slice(0, 80))
  const interesting = new Set([
    "function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "variable_declaration",
    "lexical_declaration",
    "method_definition",
  ])

  if (interesting.has(node.type)) {
    const name = declarationName(node)
    if (name) {
      const kind =
        node.type === "function_declaration"
          ? "function"
          : node.type === "class_declaration"
            ? "class"
            : node.type === "interface_declaration"
              ? "interface"
              : node.type === "type_alias_declaration"
                ? "type_alias"
                : node.type === "enum_declaration"
                  ? "enum"
                  : node.type === "method_definition"
                    ? "method"
                    : "const"
      result.push({
        name,
        kind,
        exported: nextExported,
        ...nodeRange(node),
      })
    }
  }

  for (const child of node.namedChildren) {
    walkDeclarations(child, result, nextExported)
  }
}

export async function parseTreeSitterDeclarations(path: string, source: string): Promise<TreeSitterDeclarationV1[]> {
  const { ParserCtor, tsLang, tsxLang } = await ensureTreeSitterLanguages()
  const parser: Parser = new ParserCtor()
  parser.setLanguage(languageForPath(path, tsLang, tsxLang))
  const tree = parser.parse(source)
  const declarations: TreeSitterDeclarationV1[] = []
  walkDeclarations(tree.rootNode, declarations)
  return declarations
}

export async function findTreeSitterNode(
  path: string,
  source: string,
  predicate: (node: import("web-tree-sitter").Node) => boolean,
): Promise<import("web-tree-sitter").Node | null> {
  const { ParserCtor, tsLang, tsxLang } = await ensureTreeSitterLanguages()
  const parser: Parser = new ParserCtor()
  parser.setLanguage(languageForPath(path, tsLang, tsxLang))
  const tree = parser.parse(source)
  let match: import("web-tree-sitter").Node | null = null
  const visit = (node: import("web-tree-sitter").Node): void => {
    if (match) return
    if (predicate(node)) {
      match = node
      return
    }
    for (const child of node.namedChildren) visit(child)
  }
  visit(tree.rootNode)
  return match
}
