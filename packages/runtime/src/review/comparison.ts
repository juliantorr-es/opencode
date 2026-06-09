import { Effect, Context, Layer, Schema } from "effect"
import { AppFileSystem } from "@tribunus/core/filesystem"
import { createHash } from "crypto"
import { Git } from "@/git"

// ── Data types ──────────────────────────────────────────────────────────

export const DiffEntry = Schema.Struct({
  file: Schema.String,
  type: Schema.Literals(["added", "removed", "modified"]),
  oldSha: Schema.optional(Schema.String),
  newSha: Schema.optional(Schema.String),
  linesAdded: Schema.optional(Schema.Finite),
  linesRemoved: Schema.optional(Schema.Finite),
})
export type DiffEntry = typeof DiffEntry.Type

export const ComparisonResult = Schema.Struct({
  method: Schema.Literals(["diff", "structural", "semantic"]),
  baselineId: Schema.String,
  targetId: Schema.String,
  diffs: Schema.Array(DiffEntry),
})
export type ComparisonResult = typeof ComparisonResult.Type

// ── Service interface ───────────────────────────────────────────────────

export interface Interface {
  readonly diff: (cwd: string, fileA: string, fileB: string) => Effect.Effect<DiffEntry[], never, never>
  readonly structural: (
    subjectA: { id: string; path: string },
    subjectB: { id: string; path: string },
  ) => Effect.Effect<ComparisonResult, never, never>
  readonly semantic: (
    subjectA: { id: string; path: string },
    subjectB: { id: string; path: string },
  ) => Effect.Effect<ComparisonResult, never, never>
  readonly diffSubjects: (
    baselineId: string,
    targetId: string,
    files: { baseline: string; target: string }[],
  ) => Effect.Effect<ComparisonResult, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@tribunus/ReviewComparison") {}

// ── Helpers ─────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function parseGitDiffOutput(output: string): DiffEntry[] {
  const entries: DiffEntry[] = []
  const lines = output.split("\n")
  let currentFile = ""
  let added = 0
  let removed = 0

  for (const line of lines) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\//)
    if (fileMatch) {
      if (currentFile && (added > 0 || removed > 0)) {
        entries.push({
          file: currentFile,
          type: "modified",
          linesAdded: added,
          linesRemoved: removed,
        })
      }
      currentFile = fileMatch[1]!
      added = 0
      removed = 0
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch) {
      const newLines = parseInt(hunkMatch[2] ?? "1", 10)
      added += newLines
    }

    const addLine = line.match(/^\+[^+]/)
    const delLine = line.match(/^-[^-]/)
    if (addLine) added++
    if (delLine) removed++
  }

  if (currentFile && (added > 0 || removed > 0)) {
    entries.push({
      file: currentFile,
      type: "modified",
      linesAdded: added,
      linesRemoved: removed,
    })
  }

  return deduplicateEntries(entries)
}

function deduplicateEntries(entries: DiffEntry[]): DiffEntry[] {
  const seen = new Set<string>()
  return entries.filter((e) => {
    const key = `${e.file}:${e.type}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── Layer ───────────────────────────────────────────────────────────────

export const defaultLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const git = yield* Git.Service

    const diff: Interface["diff"] = (cwd, fileA, fileB) =>
      Effect.gen(function* () {
        const contentA = yield* fs.readFileString(fileA)
        const contentB = yield* fs.readFileString(fileB)
        const hashA = sha256(contentA)
        const hashB = sha256(contentB)

        if (hashA === hashB) return [] as DiffEntry[]

        const args = ["diff", "--no-color", "--", fileA, fileB]
        const result = yield* git.run(args, { cwd }).pipe(Effect.orDie)

        if (result.exitCode !== 0) {
          return [
            {
              file: fileB,
              type: "modified" as const,
              oldSha: hashA,
              newSha: hashB,
            },
          ] as DiffEntry[]
        }

        const diffOutput = result.text()
        if (!diffOutput.trim()) {
          return [
            {
              file: fileB,
              type: "modified" as const,
              oldSha: hashA,
              newSha: hashB,
            },
          ] as DiffEntry[]
        }

        return parseGitDiffOutput(diffOutput)
      }).pipe(Effect.orDie)

    const structural: Interface["structural"] = (subjectA, subjectB) =>
      Effect.gen(function* () {
        const contentA = yield* fs.readFileString(subjectA.path)
        const contentB = yield* fs.readFileString(subjectB.path)
        const hashA = sha256(contentA)
        const hashB = sha256(contentB)

        if (hashA === hashB) {
          return {
            method: "structural" as const,
            baselineId: subjectA.id,
            targetId: subjectB.id,
            diffs: [],
          }
        }

        return {
          method: "structural" as const,
          baselineId: subjectA.id,
          targetId: subjectB.id,
          diffs: [
            {
              file: subjectB.path,
              type: "modified" as const,
              oldSha: hashA,
              newSha: hashB,
            },
          ],
        }
      }).pipe(Effect.orDie)

    const semantic: Interface["semantic"] = (subjectA, subjectB) =>
      Effect.gen(function* () {
        const result = yield* structural(subjectA, subjectB)
        return {
          ...result,
          method: "semantic" as const,
        }
      }).pipe(Effect.orDie)

    const diffSubjects: Interface["diffSubjects"] = (baselineId, targetId, files) =>
      Effect.gen(function* () {
        const allDiffs: DiffEntry[] = []
        for (const pair of files) {
          const diffs = yield* diff("", pair.baseline, pair.target)
          allDiffs.push(...diffs)
        }
        return {
          method: "diff" as const,
          baselineId,
          targetId,
          diffs: allDiffs,
        }
      }).pipe(Effect.orDie)

    return Service.of({ diff, structural, semantic, diffSubjects })
  }),
)

export const layer = defaultLayer

export * as ReviewComparison from "./comparison"
