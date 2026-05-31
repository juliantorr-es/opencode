import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./read-lib.txt"

const Parameters = Schema.Struct({
  package: Schema.String.annotate({
    description:
      "Package name or path relative to workspace root, e.g. 'effect' or 'node_modules/effect/dist/Layer.d.ts'",
  }),
  file: Schema.optional(Schema.String).annotate({
    description: "Specific file within the package, e.g. 'Layer.d.ts', 'ManagedRuntime.d.ts'",
  }),
  symbol: Schema.optional(Schema.String).annotate({
    description: "Look for a specific exported symbol: class, interface, function name",
  }),
  grep_pattern: Schema.optional(Schema.String).annotate({
    description: "Grep for a pattern across the package's type definitions",
  }),
  summary_only: Schema.optional(Schema.Boolean).annotate({
    description: "Return only the matching lines, not full file content",
  }),
})

export const ReadLibTool = Tool.define(
  "read_lib",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      cacheable: true,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const root = instance.directory
          const nodeModules = path.join(root, "node_modules")

          // Resolve package path
          let pkgPath = path.join(nodeModules, params.package)
          if (!(yield* fs.existsSafe(pkgPath))) {
            // Try common variants
            const variants = [
              params.package,
              path.join("@opencode", params.package),
              path.join("effect", params.package),
            ]
            let found = false
            for (const variant of variants) {
              const candidate = path.join(nodeModules, variant)
              if (yield* fs.existsSafe(candidate)) {
                pkgPath = candidate
                found = true
                break
              }
            }
            if (!found) {
              return {
                title: "read_lib",
                metadata: { status: "not_found" },
                output: JSON.stringify(
                  {
                    status: "not_found",
                    package: params.package,
                    hint: "Package not in node_modules. Try a different package name or check the path.",
                  },
                  null,
                  2,
                ),
              }
            }
          }

          const result: Record<string, unknown> = {
            package: params.package,
            resolved_path: pkgPath,
          }

          if (params.file) {
            let filePath = path.join(pkgPath, params.file)
            if (!(yield* fs.existsSafe(filePath))) {
              // Search for the file recursively
              const entries = yield* fs.readDirectory(pkgPath)
              const matches: string[] = []
              yield* Effect.forEach(entries, (entry) =>
                Effect.gen(function* () {
                  const fullPath = path.join(pkgPath, entry)
                  const stat = yield* fs.stat(fullPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                  if (stat?.type === "File" && entry === params.file) {
                    matches.push(fullPath)
                  }
                }),
              )

              if (matches.length > 0) {
                filePath = matches[0]
              } else {
                // Try rglob for .d.ts files
                const allFiles: string[] = []
                yield* walkDirectory(fs, pkgPath, allFiles, ".d.ts", 3)
                result.error = `File '${params.file}' not found in ${pkgPath}`
                result.available_files = allFiles.slice(0, 20)
                return {
                  title: "read_lib",
                  metadata: { status: "not_found" },
                  output: JSON.stringify(result, null, 2),
                }
              }
            }

            const content = yield* fs.readFileString(filePath)
            const lines = content.split("\n")
            result.file = filePath
            result.total_lines = lines.length

            if (params.symbol) {
              const found: { line: number; context: string }[] = []
              const escapedSymbol = params.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              const symbolRegex = new RegExp(`\\b${escapedSymbol}\\b`)
              for (let i = 0; i < lines.length; i++) {
                if (symbolRegex.test(lines[i])) {
                  const start = Math.max(0, i - 2)
                  const end = Math.min(lines.length, i + 20)
                  found.push({
                    line: i + 1,
                    context: lines.slice(start, end).join("\n"),
                  })
                }
              }
              if (found.length > 0) {
                result.symbol = params.symbol
                result.matches = found.slice(0, 3)
                if (!params.summary_only) {
                  result.content = lines.slice(0, 200).join("\n")
                }
              } else {
                result.symbol = params.symbol
                result.note = `Symbol '${params.symbol}' not found in file`
              }
            } else if (params.summary_only) {
              result.preview = lines.slice(0, 30).join("\n")
              result.tail = lines.slice(-10).join("\n")
            } else {
              result.content = content
              result.content_length = lines.length
            }
          } else if (params.grep_pattern) {
            // Grep across all .d.ts files
            const matches: { file: string; line: number; text: string }[] = []
            const grepRegex = new RegExp(params.grep_pattern, "i")

            const allFiles: string[] = []
            yield* walkDirectory(fs, pkgPath, allFiles, ".d.ts", 3)

            for (const f of allFiles.slice(0, 50)) {
              try {
                const fileContent = yield* fs.readFileString(f)
                const fileLines = fileContent.split("\n")
                for (let i = 0; i < fileLines.length; i++) {
                  if (grepRegex.test(fileLines[i])) {
                    matches.push({
                      file: path.relative(pkgPath, f),
                      line: i + 1,
                      text: fileLines[i].trim().slice(0, 200),
                    })
                  }
                }
              } catch {
                // skip unreadable files
              }
            }

            result.grep_pattern = params.grep_pattern
            result.matches = matches.slice(0, 30)
            result.match_count = matches.length
          } else {
            // List package contents
            const allTypeFiles: string[] = []
            yield* walkDirectory(fs, pkgPath, allTypeFiles, ".d.ts", 2)
            const files = allTypeFiles.slice(0, 30)

            const dirs: string[] = []
            const dirEntries = yield* fs.readDirectory(pkgPath)
            for (const entry of dirEntries) {
              const fullPath = path.join(pkgPath, entry)
              const stat = yield* fs.stat(fullPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (stat?.type === "Directory") {
                dirs.push(entry)
              }
            }

            result.type_files = files.map((f) => path.relative(pkgPath, f))
            result.directories = dirs.slice(0, 10)
            result.hint = "Specify file=<name> to read a specific file, or grep_pattern=<pattern> to search"
          }

          return {
            title: params.package,
            metadata: { resolved_path: pkgPath },
            output: JSON.stringify(result, null, 2),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const walkDirectory = Effect.fnUntraced(function* (
  fs: AppFileSystem.Interface,
  dir: string,
  results: string[],
  ext: string,
  maxDepth: number,
): Effect.Effect<void> {
  if (maxDepth <= 0) return
  try {
    const entries = yield* fs.readDirectory(dir)
    for (const entry of entries) {
      const fullPath = path.join(dir, entry)
      const stat = yield* fs.stat(fullPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (stat?.type === "Directory") {
        yield* walkDirectory(fs, fullPath, results, ext, maxDepth - 1)
      } else if (entry.endsWith(ext)) {
        results.push(fullPath)
      }
    }
  } catch {
    // skip inaccessible directories
  }
})

export * as ReadLib from "./read-lib"
