import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent"
import { readFileSync, statSync, existsSync } from "node:fs"
import { sha256 } from "./_lib/hashing.js"
import { setContext, createEnvelope } from "./_lib/envelope.js"
import { resolveReadPath } from "./_lib/path-policy.js"
import { buildToolContext } from "./_lib/tool-context.js"
import type { OmpToolEnvelopeV1 } from "./_lib/types.js"
import type { Parser, Language } from "web-tree-sitter"

// ── Tree-sitter lazy init ──
// Dynamic import: WASM files may not exist at module init time.
let tsReady = false
let ParserCtor: typeof Parser | null = null
let tsLang: Language | null = null
let tsxLang: Language | null = null

async function ensureTs(): Promise<void> {
  if (tsReady) return
  const mod: {
    default: { init(): Promise<void>; Language: typeof Language; Parser: typeof Parser }
  } = await import("web-tree-sitter")
  await mod.default.init()
  const base = import.meta.resolve("tree-sitter-typescript")
  const baseDir = base.replace("file://", "").replace("/tree-sitter.json", "")
  tsLang = await mod.default.Language.load(baseDir + "/tree-sitter-typescript.wasm")
  tsxLang = await mod.default.Language.load(baseDir + "/tree-sitter-tsx.wasm")
  ParserCtor = mod.default.Parser
  tsReady = true
}

function astFocus(
  source: string,
  name: string,
  filePath: string,
): { start: number; end: number; startLine: number; endLine: number } | null {
  const lang = filePath.endsWith(".tsx") ? tsxLang : tsLang
  if (!ParserCtor || !lang) return null
  const parser = new ParserCtor()
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
  const visit = () => {
    const node = cursor.currentNode()
    if (result) return
    if (targetTypes.includes(node.type)) {
      const nodeText = source.slice(node.startIndex, node.endIndex)
      if (nodeText.includes(name)) {
        result = { start: node.startIndex, end: node.endIndex }
        return
      }
    }
    if (!result && cursor.gotoFirstChild()) {
      visit()
      cursor.gotoParent()
    }
    if (!result && cursor.gotoNextSibling()) visit()
  }
  visit()

  if (!result) return null

  const startLine = source.slice(0, result.start).split("\n").length
  const endLine = startLine + source.slice(result.start, result.end).split("\n").length - 1
  return { ...result, startLine, endLine }
}

// ── Symbol extraction (regex-based) ──

interface SymbolEntry {
  line: number
  name: string
  kind: string
}

function extractSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]!.trim()
    let m: RegExpMatchArray | null
    m = s.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1]!, kind: "function" })
      continue
    }
    m = s.match(/^(?:export\s+)?class\s+(\w+)/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1]!, kind: "class" })
      continue
    }
    m = s.match(/^(?:export\s+)?(?:interface|type)\s+(\w+)/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1]!, kind: "type" })
      continue
    }
    m = s.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?[\(\{function]/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1]!, kind: "const_fn" })
      continue
    }
  }
  return symbols
}

function findBlockEndLine(lines: string[], startIdx: number): number {
  let depth = 0
  let started = false
  const maxScan = 500
  const limit = Math.min(lines.length, startIdx + maxScan)
  for (let j = startIdx; j < limit; j++) {
    const line = lines[j]!
    for (const ch of line) {
      if (ch === "{" || ch === "(") {
        depth++
        started = true
      }
      if (ch === "}" || ch === ")") depth--
    }
    if (started && depth === 0) {
      return j + 1
    }
  }
  // No brace matched — single-line declaration
  return startIdx + 1
}

function focusByBraceCounting(
  lines: string[],
  syms: SymbolEntry[],
  focusName: string,
): { content: string; startLine: number; endLine: number } | null {
  const sym =
    syms.find((s) => s.name === focusName) ??
    syms.find((s) => s.name.toLowerCase() === focusName.toLowerCase())
  if (!sym) return null

  const start = sym.line - 1
  const endIdx = findBlockEndLine(lines, start) - 1
  const section = lines.slice(start, endIdx + 1).join("\n")

  return {
    content: section,
    startLine: start + 1,
    endLine: endIdx + 1,
  }
}

// ── Truncation helpers ──

function truncateToBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str
  let truncated = Buffer.from(str, "utf8").subarray(0, maxBytes).toString("utf8")
  // Remove trailing replacement character from split multi-byte
  while (truncated.length > 0 && truncated.charCodeAt(truncated.length - 1) === 0xfffd) {
    truncated = truncated.slice(0, -1)
  }
  return truncated
}

function applyContentLimits(
  content: string,
  maxBytes: number,
  maxLines: number,
  baseLine: number,
): {
  content: string
  truncated: boolean
  continuation?: { next_start_line?: number; reason: string }
} {
  if (maxLines <= 0 && maxBytes <= 0) {
    return { content, truncated: false }
  }

  const lines = content.split("\n")

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    return {
      content: kept.join("\n"),
      truncated: true,
      continuation: {
        next_start_line: baseLine + maxLines,
        reason: "max_lines",
      },
    }
  }

  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    const truncated = truncateToBytes(content, maxBytes)
    return {
      content: truncated,
      truncated: true,
      continuation: { reason: "max_bytes" },
    }
  }

  return { content, truncated: false }
}

// ── Types ──

type StructReadOutput = {
  path: string
  sha256?: string
  size_bytes: number
  total_lines: number
  mode: string
  content?: string
  range?: { start_line: number; end_line: number }
  symbols?: Array<{ name: string; kind: string; start_line: number; end_line: number }>
  focused_symbol?: {
    name: string
    kind: string
    start_line: number
    end_line: number
    content: string
  }
  truncated?: boolean
  continuation?: { next_start_line?: number; reason: string }
  symbol_confidence?: "ast" | "heuristic" | "none"
}

type ToolResponse = {
  content: Array<{ type: string; text: string }>
  details?: Record<string, unknown>
}

// ── Envelope helpers (multi-statement; reused by two or more error paths) ──

function makeRefusedEnvelope(
  code: string,
  message: string,
  path: string,
  startedAt: string,
): OmpToolEnvelopeV1 {
  return createEnvelope({
    tool_id: "struct_read",
    tool_version: "1.0.0",
    invocation_id: `refused-${Date.now()}`,
    started_at: startedAt,
    status: "refused",
    risk_level: "read",
    requires_approval: false,
    requires_hash_precondition: false,
    result: {
      path,
      mode: "full",
      size_bytes: 0,
      total_lines: 0,
    } satisfies StructReadOutput,
    error: {
      code: code as OmpToolEnvelopeV1["error"]["code"],
      message,
      retryable: false,
    },
    denied_paths: [path],
  })
}

function makeErrorEnvelope(
  code: string,
  message: string,
  path: string,
  startedAt: string,
): OmpToolEnvelopeV1 {
  return createEnvelope({
    tool_id: "struct_read",
    tool_version: "1.0.0",
    invocation_id: `error-${Date.now()}`,
    started_at: startedAt,
    status: "error",
    risk_level: "read",
    requires_approval: false,
    requires_hash_precondition: false,
    result: {
      path,
      mode: "full",
      size_bytes: 0,
      total_lines: 0,
    } satisfies StructReadOutput,
    error: {
      code: code as OmpToolEnvelopeV1["error"]["code"],
      message,
      retryable: false,
    },
  })
}

function wrapResult(envelope: OmpToolEnvelopeV1): ToolResponse {
  const status = envelope.status
  let text: string

  if (status === "refused" || status === "error") {
    text = `${status}: ${envelope.error?.message ?? "Unknown error"}`
  } else if (status === "ok" && envelope.result) {
    text = JSON.stringify(envelope.result, null, 2)
  } else {
    text = status
  }

  return {
    content: [{ type: "text", text }],
    details: envelope as unknown as Record<string, unknown>,
  }
}

// ── Factory ──

const factory: CustomToolFactory = (pi) => ({
  name: "struct_read",
  label: "Structured Read",
  description:
    "Read a source file and return a structured digest. Supports full content, head, line range, symbol listing, and single-symbol focus modes with tree-sitter AST extraction for .ts/.tsx files.",
  parameters: pi.zod.object({
    path: pi.zod.string().describe("File path to read"),
    mode: pi.zod
      .enum(["full", "head", "range", "symbols", "focus"])
      .optional()
      .default("full")
      .describe("Read mode: full content, head (first N lines), range (line range), symbols (list), focus (single symbol)"),
    start_line: pi.zod
      .number()
      .optional()
      .describe("Start line for 'range' mode (1-indexed)"),
    end_line: pi.zod
      .number()
      .optional()
      .describe("End line for 'range' mode (1-indexed, inclusive)"),
    symbol_name: pi.zod
      .string()
      .optional()
      .describe("Symbol name to extract for 'focus' mode"),
    max_bytes: pi.zod
      .number()
      .optional()
      .default(50000)
      .describe("Maximum output bytes (default 50000)"),
    max_lines: pi.zod
      .number()
      .optional()
      .default(2000)
      .describe("Maximum output lines (default 2000)"),
    include_sha256: pi.zod
      .boolean()
      .optional()
      .default(true)
      .describe("Include SHA-256 of file content (default true)"),
    include_line_numbers: pi.zod
      .boolean()
      .optional()
      .default(false)
      .describe("Prefix content lines with line numbers (default false)"),
  }),

  async execute(_toolCallId, params, _onUpdate, ctx, signal) {
    const startedAt = new Date().toISOString()
    const ompCtx = buildToolContext({
      cwd: pi.cwd,
      mode: "loose",
      actor: { kind: "agent", id: ctx.sessionId ?? "unknown" },
    })
    setContext(ompCtx)

    if (signal?.aborted) {
      return wrapResult(makeRefusedEnvelope("CANCELLED", "Execution cancelled before work began", params.path, startedAt))
    }

    // --- Validate mode-specific params ---
    if (params.mode === "range") {
      if (params.start_line == null || params.end_line == null) {
        return wrapResult(makeErrorEnvelope("INVALID_INPUT", "start_line and end_line are required for 'range' mode", params.path, startedAt))
      }
      if (params.start_line < 1 || params.end_line < params.start_line) {
        return wrapResult(makeErrorEnvelope("INVALID_INPUT", `Invalid range: start_line=${params.start_line}, end_line=${params.end_line}`, params.path, startedAt))
      }
    }

    if (params.mode === "focus" && !params.symbol_name) {
      return wrapResult(makeErrorEnvelope("INVALID_INPUT", "symbol_name is required for 'focus' mode", params.path, startedAt))
    }

    // --- Path resolution ---
    const decision = resolveReadPath(params.path, ompCtx)
    if (!decision.allowed) {
      return wrapResult(makeRefusedEnvelope("PATH_DENIED", decision.reason ?? `Access denied to path: ${params.path}`, params.path, startedAt))
    }

    const resolvedPath = decision.resolved_path!

    // --- File existence check ---
    if (!existsSync(resolvedPath)) {
      return wrapResult(makeErrorEnvelope("PATH_NOT_FOUND", `File not found: ${params.path}`, params.path, startedAt))
    }

    // --- Stat & read ---
    const stats = statSync(resolvedPath)
    const fileBytes = stats.size

    const rawContent = readFileSync(resolvedPath, "utf8")
    const fileHash = sha256(rawContent)
    const allLines = rawContent.split("\n")
    const totalLines = allLines.length

    // ── Mode dispatch ──

    const output: StructReadOutput = {
      path: params.path,
      size_bytes: fileBytes,
      total_lines: totalLines,
      mode: params.mode,
    }

    if (params.include_sha256) {
      output.sha256 = fileHash
    }

    if (params.mode === "full" || params.mode === "head") {
      const content = params.mode === "head"
        ? allLines.slice(0, params.max_lines).join("\n")
        : rawContent

      if (params.include_line_numbers) {
        const lines = content.split("\n")
        const numbered = lines.map((line, i) => `${i + 1}:${line}`).join("\n")
        const limited = applyContentLimits(numbered, params.max_bytes, params.max_lines, 1)
        output.content = limited.content
        if (limited.truncated) {
          output.truncated = true
          output.continuation = limited.continuation
        }
      } else {
        const limited = applyContentLimits(content, params.max_bytes, params.max_lines, 1)
        output.content = limited.content
        if (limited.truncated) {
          output.truncated = true
          output.continuation = limited.continuation
        }
      }
    } else if (params.mode === "range") {
      const startIdx = params.start_line! - 1
      const endIdx = params.end_line!
      const rangeContent = allLines.slice(startIdx, endIdx).join("\n")

      if (params.include_line_numbers) {
        const numbered = allLines.slice(startIdx, endIdx).map((line, i) => `${startIdx + i + 1}:${line}`).join("\n")
        const limited = applyContentLimits(numbered, params.max_bytes, params.max_lines, params.start_line!)
        output.content = limited.content
        if (limited.truncated) {
          output.truncated = true
          output.continuation = limited.continuation
        }
      } else {
        const limited = applyContentLimits(rangeContent, params.max_bytes, params.max_lines, params.start_line!)
        output.content = limited.content
        if (limited.truncated) {
          output.truncated = true
          output.continuation = limited.continuation
        }
      }

      output.range = {
        start_line: params.start_line!,
        end_line: Math.min(params.end_line!, totalLines),
      }
    } else if (params.mode === "symbols") {
      const rawSymbols = extractSymbols(allLines)
      output.symbols = rawSymbols.map((s) => ({
        name: s.name,
        kind: s.kind,
        start_line: s.line,
        end_line: findBlockEndLine(allLines, s.line - 1),
      }))
    } else if (params.mode === "focus") {
      const focusName = params.symbol_name!
      let focused: { content: string; startLine: number; endLine: number } | null = null
      let confidence: "ast" | "heuristic" | "none" = "none"

      // Try tree-sitter AST for .ts/.tsx files
      if (resolvedPath.endsWith(".ts") || resolvedPath.endsWith(".tsx")) {
        try {
          await ensureTs()
          const range = astFocus(rawContent, focusName, resolvedPath)
          if (range) {
            focused = {
              content: rawContent.slice(range.start, range.end),
              startLine: range.startLine,
              endLine: range.endLine,
            }
            confidence = "ast"
          }
        } catch {
          // Tree-sitter unavailable — fall through to heuristic
        }
      }

      // Regex + brace counting fallback
      if (!focused) {
        const syms = extractSymbols(allLines)
        focused = focusByBraceCounting(allLines, syms, focusName)
        if (focused) {
          confidence = "heuristic"
        }
      }

      if (focused) {
        // Apply truncation
        const limited = applyContentLimits(focused.content, params.max_bytes, params.max_lines, focused.startLine)

        // Resolve symbol kind
        let kind: string
        if (confidence === "ast") {
          kind = "symbol"
        } else {
          const raw = extractSymbols(allLines)
          const sym = raw.find(
            (s) => s.name === focusName || s.name.toLowerCase() === focusName.toLowerCase(),
          )
          kind = sym?.kind ?? "unknown"
        }

        output.focused_symbol = {
          name: focusName,
          kind,
          start_line: focused.startLine,
          end_line: focused.endLine,
          content: limited.content,
        }
        output.range = {
          start_line: focused.startLine,
          end_line: focused.endLine,
        }
        output.symbol_confidence = confidence

        if (limited.truncated) {
          output.truncated = true
          output.continuation = limited.continuation
        }
      } else {
        // Symbol not found by any method
        return wrapResult({
          ...makeErrorEnvelope("MATCH_NOT_FOUND", `Symbol '${focusName}' not found in ${params.path}`, params.path, startedAt),
          result: {
            path: params.path,
            mode: params.mode,
            size_bytes: fileBytes,
            total_lines: totalLines,
            symbol_confidence: "none",
          } satisfies StructReadOutput,
        })
      }
    }

    const envelope = createEnvelope({
      tool_id: "struct_read",
      tool_version: "1.0.0",
      invocation_id: `${ctx.sessionId ?? "unknown"}-${Date.now()}`,
      started_at: startedAt,
      status: "ok",
      risk_level: "read",
      requires_approval: false,
      requires_hash_precondition: false,
      result: output satisfies StructReadOutput,
      read_paths: [params.path],
    })
    return wrapResult(envelope)
  },
})

export default factory
