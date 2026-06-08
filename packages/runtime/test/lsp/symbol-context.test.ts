import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SymbolContext } from "@/lsp/symbol-context"
import { LSP } from "@/lsp/lsp"

// --- Stubs ---

const nestedSymbols = [
  {
    name: "Outer",
    kind: 5,
    range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
    selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
    children: [
      {
        name: "method",
        kind: 6,
        range: { start: { line: 2, character: 2 }, end: { line: 8, character: 3 } },
        selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 8 } },
        children: [
          {
            name: "inner",
            kind: 12,
            range: { start: { line: 4, character: 4 }, end: { line: 6, character: 5 } },
            selectionRange: { start: { line: 4, character: 4 }, end: { line: 4, character: 9 } },
          },
        ],
      },
    ],
  },
]

const flatSymbols = [
  { name: "funcA", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } } },
  { name: "funcB", kind: 12, range: { start: { line: 7, character: 0 }, end: { line: 10, character: 1 } }, selectionRange: { start: { line: 7, character: 0 }, end: { line: 10, character: 1 } } },
]

const line0Symbols = [
  { name: "first", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } } },
]

// --- expandRangeFromSymbolContexts ---

describe("expandRangeFromSymbolContexts", () => {
  test("returns deepest nested symbol range for cursor inside inner function", () => {
    const result = SymbolContext.expandRangeFromSymbolContexts(nestedSymbols, 5)
    expect(result).toBeDefined()
    expect(result!.start.line).toBe(4)
    expect(result!.end.line).toBe(6)
  })

  test("returns outer symbol range when cursor is inside method but not inner", () => {
    const result = SymbolContext.expandRangeFromSymbolContexts(nestedSymbols, 3)
    expect(result).toBeDefined()
    expect(result!.start.line).toBe(2)
    expect(result!.end.line).toBe(8)
  })

  test("returns outermost symbol when cursor is at class level", () => {
    const result = SymbolContext.expandRangeFromSymbolContexts(nestedSymbols, 1)
    expect(result).toBeDefined()
    expect(result!.start.line).toBe(0)
    expect(result!.end.line).toBe(10)
  })

  test("finds a symbol containing the cursor line (not just start line)", () => {
    const result = SymbolContext.expandRangeFromSymbolContexts(flatSymbols, 3)
    expect(result).toBeDefined()
    expect(result!.start.line).toBe(0)
    expect(result!.end.line).toBe(5)
  })

  test("finds second symbol when cursor is in its range", () => {
    const result = SymbolContext.expandRangeFromSymbolContexts(flatSymbols, 9)
    expect(result).toBeDefined()
    expect(result!.start.line).toBe(7)
    expect(result!.end.line).toBe(10)
  })

  test("returns undefined when cursor is outside all symbol ranges", () => {
    const result = SymbolContext.expandRangeFromSymbolContexts(flatSymbols, 12)
    expect(result).toBeUndefined()
  })

  test("returns undefined for empty symbols", () => {
    const result = SymbolContext.expandRangeFromSymbolContexts([], 0)
    expect(result).toBeUndefined()
  })

  test("handles line-0 cursor (not falsely rejected)", () => {
    const result = SymbolContext.expandRangeFromSymbolContexts(line0Symbols, 0)
    expect(result).toBeDefined()
    expect(result!.start.line).toBe(0)
    expect(result!.end.line).toBe(3)
  })
})

// --- formatSymbolContexts ---

describe("formatSymbolContexts", () => {
  test("formats a single flat context", () => {
    const contexts: SymbolContext.SymbolContext[] = [
      { path: [{ name: "funcA", range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } }, children: [] }] },
    ]
    const result = SymbolContext.formatSymbolContexts(contexts)
    expect(result).toBe("funcA [1-6]")
  })

  test("formats nested context paths with indentation", () => {
    const contexts: SymbolContext.SymbolContext[] = [
      {
        path: [
          { name: "Outer", range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } }, children: [] },
          { name: "method", range: { start: { line: 2, character: 2 }, end: { line: 8, character: 3 } }, children: [] },
        ],
      },
    ]
    const result = SymbolContext.formatSymbolContexts(contexts)
    expect(result).toBe("Outer [1-11]\n  method [3-9]")
  })

  test("separates multiple contexts with blank line", () => {
    const contexts: SymbolContext.SymbolContext[] = [
      { path: [{ name: "funcA", range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } }, children: [] }] },
      { path: [{ name: "funcB", range: { start: { line: 7, character: 0 }, end: { line: 10, character: 1 } }, children: [] }] },
    ]
    const result = SymbolContext.formatSymbolContexts(contexts)
    expect(result).toBe("funcA [1-6]\n\nfuncB [8-11]")
  })

  test("returns empty string for empty contexts", () => {
    const result = SymbolContext.formatSymbolContexts([])
    expect(result).toBe("")
  })
})

// --- resolveSymbolContexts (integration with LSP stub) ---

describe("resolveSymbolContexts", () => {
  const nestedStub = LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(true),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed(nestedSymbols),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  })

  test("returns contexts for overlapping lines", async () => {
    const result = await Effect.runPromise(
      SymbolContext.resolveSymbolContexts(nestedStub, "/test/file.ts", 4, 6),
    )
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].path.map((s) => s.name)).toEqual(["Outer", "method", "inner"])
  })

  test("returns empty when no LSP clients available", async () => {
    const noClientStub = LSP.Service.of({
      ...nestedStub,
      hasClients: () => Effect.succeed(false),
    })
    const result = await Effect.runPromise(
      SymbolContext.resolveSymbolContexts(noClientStub, "/test/file.ts", 1, 10),
    )
    expect(result).toEqual([])
  })
})
