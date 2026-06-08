import { Effect } from "effect"
import { pathToFileURL } from "url"
import { LSP } from "./lsp"

// --- Types ---

export type SymbolRange = {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export type SymbolNode = {
  name: string
  range: SymbolRange
  children: SymbolNode[]
}

export type SymbolContext = {
  path: SymbolNode[]
}

type DocumentSymbolWithChildren = LSP.DocumentSymbol & { children?: Array<LSP.DocumentSymbol | LSP.Symbol> }

// --- Private helpers (extracted from read.ts) ---

const MAX_SYMBOL_DEPTH = 200

function normalizeSymbols(symbols: Array<LSP.DocumentSymbol | LSP.Symbol>, depth = 1): SymbolNode[] {
  if (depth > MAX_SYMBOL_DEPTH) return []
  return symbols.flatMap((symbol) => normalizeSymbol(symbol, depth)).filter(
    (symbol): symbol is SymbolNode => Boolean(symbol),
  )
}

function normalizeSymbol(symbol: LSP.DocumentSymbol | LSP.Symbol, depth = 1): SymbolNode | undefined {
  if (depth > MAX_SYMBOL_DEPTH) return undefined
  const range = "range" in symbol ? symbol.range : symbol.location.range
  const docSymbol = symbol as DocumentSymbolWithChildren
  const children = docSymbol.children && Array.isArray(docSymbol.children) ? normalizeSymbols(docSymbol.children, depth + 1) : []
  return { name: symbol.name, range, children }
}

function collectSymbolContexts(symbols: SymbolNode[], startLine: number, endLine: number): SymbolContext[] {
  const contexts = symbols.flatMap((symbol) => collectSymbolContext(symbol, [], startLine, endLine))
  const seen = new Set<string>()
  return contexts.filter((context) => {
    const key = context.path
      .map((symbol) => `${symbol.name}:${symbol.range.start.line}-${symbol.range.end.line}`)
      .join(" > ")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function collectSymbolContext(
  symbol: SymbolNode,
  path: SymbolNode[],
  startLine: number,
  endLine: number,
  depth = 1,
): SymbolContext[] {
  if (depth > MAX_SYMBOL_DEPTH) return []
  const symbolStart = symbol.range.start.line + 1
  const symbolEnd = symbol.range.end.line + 1
  if (symbolEnd < startLine || symbolStart > endLine) return []
  const nextPath = [...path, symbol]
  const nested = symbol.children.flatMap((child) => collectSymbolContext(child, nextPath, startLine, endLine, depth + 1))
  if (nested.length > 0) return nested
  return [{ path: nextPath }]
}

// --- Exported functions ---

/** Full read-side effect: checks LSP availability, touches the file, fetches symbols, and returns overlapping symbol contexts. */
export const resolveSymbolContexts = Effect.fn("SymbolContext.resolveSymbolContexts")(function* (
  lsp: LSP.Interface,
  filepath: string,
  startLine: number,
  endLine: number,
) {
  const available = yield* lsp.hasClients(filepath).pipe(Effect.catch(() => Effect.succeed(false)))
  if (!available) return [] as SymbolContext[]

  yield* lsp.touchFile(filepath, "document").pipe(Effect.catch(() => Effect.void))

  const symbols = yield* lsp.documentSymbol(pathToFileURL(filepath).href).pipe(
    Effect.catch(() => Effect.succeed([] as Array<LSP.DocumentSymbol | LSP.Symbol>)),
  )
  return collectSymbolContexts(normalizeSymbols(symbols), startLine, endLine)
})

/** Formats symbol contexts as indented text lines for display. */
export function formatSymbolContexts(contexts: SymbolContext[]) {
  return contexts
    .map((context) =>
      context.path
        .map(
          (symbol, depth) =>
            `${"  ".repeat(depth)}${symbol.name} [${symbol.range.start.line + 1}-${symbol.range.end.line + 1}]`,
        )
        .join("\n"),
    )
    .join("\n\n")
}

/** Given raw LSP symbols and a cursor line (0-based), finds the deepest symbol containing the line and returns its range. */
export function expandRangeFromSymbolContexts(
  symbols: Array<LSP.DocumentSymbol | LSP.Symbol>,
  cursorLine: number,
): SymbolRange | undefined {
  if (!Number.isInteger(cursorLine) || cursorLine < 0) return undefined
  const nodes = normalizeSymbols(symbols)

  function deepestEnclosing(node: SymbolNode, line: number, depth = 1): SymbolNode | undefined {
    if (depth > MAX_SYMBOL_DEPTH) return undefined
    if (node.range.start.line <= line && node.range.end.line >= line) {
      for (const child of node.children) {
        const found = deepestEnclosing(child, line, depth + 1)
        if (found) return found
      }
      return node
    }
    return undefined
  }

  for (const node of nodes) {
    const found = deepestEnclosing(node, cursorLine)
    if (found) return found.range
  }
  return undefined
}

export * as SymbolContext from "./symbol-context"
