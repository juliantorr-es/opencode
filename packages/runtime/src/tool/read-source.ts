import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import path from "path"
import DESCRIPTION from "./read-source.txt"

const Parameters = Schema.Struct({
  file: Schema.String.annotate({ description: "Path to the source file" }),
  focus: Schema.optional(Schema.String).annotate({
    description: "Function name, class name, or symbol to focus on. Returns only the relevant section + imports.",
  }),
  summary_only: Schema.optional(Schema.Boolean).annotate({
    description: "Return a 10-line overview: imports, exports, top-level symbols. No body content.",
  }),
  include_imports: Schema.optional(Schema.Boolean).annotate({
    description: "Always include the import block at the top (default true)",
  }),
})

interface ImportEntry {
  line: number
  text: string
}

interface ExportEntry {
  line: number
  text: string
}

interface SymbolEntry {
  line: number
  name: string
  kind: string
  text: string
}

interface FocusSection {
  symbol: string
  kind: string
  lines: string
  content: string
}

interface LastEditInfo {
  agent: string
  session_id: string
  reason: string
  change_summary: string
  plan_step: string
  edited_at: string
  total_edits_this_session: number
}

interface EditHistoryEntry {
  agent: string
  reason: string
  edited_at: string
}

function extractImports(lines: string[]): ImportEntry[] {
  const imports: ImportEntry[] = []
  let importStarted = false
  let importEnded = false
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim()
    if (/^(import|from)\s/.test(stripped)) {
      imports.push({ line: i + 1, text: stripped })
      importStarted = true
    } else if (importStarted && stripped === "" && imports.length > 0) {
      importEnded = true
    } else if (importStarted && importEnded && stripped !== "") {
      break
    }
  }
  return imports
}

function extractExports(lines: string[]): ExportEntry[] {
  const exports: ExportEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim()
    if (/^export\s+(const|function|class|interface|type|default|async)/.test(stripped)) {
      exports.push({ line: i + 1, text: stripped })
    } else if (/^export\s+\{/.test(stripped)) {
      exports.push({ line: i + 1, text: stripped })
    }
  }
  return exports
}

function extractSymbols(lines: string[]): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim()
    // Function definitions
    let m = stripped.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1], kind: "function", text: stripped.slice(0, 120) })
      continue
    }
    // Class definitions
    m = stripped.match(/^(?:export\s+)?class\s+(\w+)/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1], kind: "class", text: stripped.slice(0, 120) })
      continue
    }
    // Interface/type
    m = stripped.match(/^(?:export\s+)?(?:interface|type)\s+(\w+)/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1], kind: "type", text: stripped.slice(0, 120) })
      continue
    }
    // Const with arrow function
    m = stripped.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1], kind: "const_fn", text: stripped.slice(0, 120) })
      continue
    }
    // Const with function expression
    m = stripped.match(/^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function/)
    if (m) {
      symbols.push({ line: i + 1, name: m[1], kind: "const_fn", text: stripped.slice(0, 120) })
    }
  }
  return symbols
}

function findFocusSection(lines: string[], symbols: SymbolEntry[], focus: string): FocusSection | null {
  for (const s of symbols) {
    if (s.name === focus) {
      let start = s.line - 1
      let end = lines.length
      // Find next top-level symbol
      for (const s2 of symbols) {
        if (s2.line > s.line) {
          end = s2.line - 1
          break
        }
      }
      // Go back to include JSDoc/comment above
      while (
        start > 0 &&
        (lines[start - 1].trim().startsWith("//") ||
          lines[start - 1].trim().startsWith("*") ||
          lines[start - 1].trim().startsWith("/**") ||
          lines[start - 1].trim() === "")
      ) {
        start--
      }
      return {
        symbol: s.name,
        kind: s.kind,
        lines: `${start + 1}-${end}`,
        content: lines.slice(start, end).join("\n"),
      }
    }
  }
  return null
}

function cleanContent(lines: string[]): string {
  const cleaned: string[] = []
  let blankCount = 0
  for (const line of lines) {
    if (line.trim() === "") {
      blankCount++
      if (blankCount <= 2) {
        cleaned.push(line)
      }
    } else {
      blankCount = 0
      cleaned.push(line)
    }
  }
  return cleaned.join("\n")
}

export const ReadSourceTool = Tool.define(
  "read_source",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const git = yield* Git.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      cacheable: true,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.file)
            ? params.file
            : path.resolve(instance.directory, params.file)
          const includeImports = params.include_imports !== false

          const relPath = path.relative(instance.directory, filePath)

          if (!(yield* fs.existsSafe(filePath))) {
            return {
              title: "read_source",
              metadata: { status: "not_found" },
              output: JSON.stringify(
                { status: "not_found", path: filePath, hint: "Check file path" },
                null,
                2,
              ),
            }
          }

          const content = yield* fs.readFileString(filePath)
          const lines = content.split("\n")

          const imports = extractImports(lines)
          const exports = extractExports(lines)
          const symbols = extractSymbols(lines)

          const digest: Record<string, unknown> = {
            path: filePath,
            language: path.extname(filePath).replace(".", ""),
            total_lines: lines.length,
            imports,
            export_count: exports.length,
            exports: exports.slice(0, 10),
            symbols,
            symbol_count: symbols.length,
          }

          if (params.summary_only) {
            digest.summary = `${path.basename(filePath)}: ${lines.length} lines, ${imports.length} imports, ${exports.length} exports, ${symbols.length} top-level symbols. Symbols: [${symbols.slice(0, 15).map((s) => s.name).join(", ")}]`
            digest.content = null
          } else if (params.focus) {
            const focused = findFocusSection(lines, symbols, params.focus)
            if (focused) {
              digest.focus = focused
              if (includeImports) {
                digest.imports = imports
              }
            }
          } else {
            digest.content = cleanContent(lines)
            digest.content_length = lines.length
          }

          // Git dirty check
          try {
            const statusResult = yield* git.run(
              ["status", "--porcelain", "--", relPath],
              { cwd: instance.directory },
            )
            const statusText = statusResult.text().trim()
            if (statusText) {
              digest.dirty = true
              digest.git_status = statusText

              const diffResult = yield* git.run(
                ["diff", "--", relPath],
                { cwd: instance.directory },
              )
              const diffText = diffResult.text().trim()
              if (diffText) {
                const diffLines = diffText.split("\n")
                digest.unstaged_diff = diffLines.slice(0, 40).join("\n")
                digest.unstaged_diff_lines = diffLines.length
                const addLines = diffLines.filter((l: string) => l.startsWith("+") && !l.startsWith("+++"))
                const delLines = diffLines.filter((l: string) => l.startsWith("-") && !l.startsWith("---"))
                digest.unstaged_diff_summary = `${addLines.length} additions, ${delLines.length} deletions`
              }

              const stagedResult = yield* git.run(
                ["diff", "--cached", "--", relPath],
                { cwd: instance.directory },
              )
              const stagedText = stagedResult.text().trim()
              if (stagedText) {
                const stagedLines = stagedText.split("\n")
                digest.staged_diff = stagedLines.slice(0, 40).join("\n")
                digest.staged = true
              }
            } else {
              digest.dirty = false
            }
          } catch {
            digest.dirty = "unknown"
            digest.dirty_note = "Could not run git — not a git repo or git not available"
          }

          // Edit metadata check
          try {
            const editLogDir = path.join(instance.directory, "docs", "json", "opencode", "sessions")
            const allEdits: Record<string, unknown>[] = []

            if (yield* fs.existsSafe(editLogDir)) {
              const sessionDirs = yield* fs.readDirectory(editLogDir)
              for (const sessionDir of sessionDirs) {
                const logFile = path.join(editLogDir, sessionDir, "edits", "edit_log.v1.jsonl")
                if (!(yield* fs.existsSafe(logFile))) continue

                const logContent = yield* fs.readFileString(logFile)
                for (const lineText of logContent.split("\n")) {
                  if (!lineText.trim()) continue
                  try {
                    const entry = JSON.parse(lineText) as Record<string, unknown>
                    if (entry.file === relPath || entry.file === filePath) {
                      allEdits.push(entry)
                    }
                  } catch {
                    // skip malformed lines
                  }
                }
              }

              if (allEdits.length > 0) {
                const latest = allEdits[allEdits.length - 1] as Record<string, unknown>
                digest.last_edit = {
                  agent: latest.agent as string,
                  session_id: latest.session_id as string,
                  reason: latest.reason as string,
                  change_summary: latest.change_summary as string,
                  plan_step: latest.plan_step as string,
                  edited_at: latest.edited_at as string,
                  total_edits_this_session: allEdits.filter(
                    (e) => e.session_id === latest.session_id,
                  ).length,
                } satisfies LastEditInfo

                if (allEdits.length > 1) {
                  digest.edit_history = allEdits
                    .slice(-5)
                    .map((e) => ({
                      agent: (e as Record<string, unknown>).agent as string,
                      reason: (e as Record<string, unknown>).reason as string,
                      edited_at: (e as Record<string, unknown>).edited_at as string,
                    })) satisfies EditHistoryEntry[]
                }
              }
            }
          } catch {
            // edit metadata check is best-effort
          }

          return {
            title: path.basename(filePath),
            metadata: {
              total_lines: lines.length,
              imports: imports.length,
              exports: exports.length,
              symbols: symbols.length,
            },
            output: JSON.stringify(digest, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ReadSource from "./read-source"
