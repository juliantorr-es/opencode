import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export interface VerifyReviewPacketsInputV1 {
  source_zip_path?: string
  ir_zip_path?: string
}

export interface VerifyReviewPacketsResultV1 {
  source_zip_sha256: string
  ir_zip_sha256: string
  source_zip_files: number
  source_graph: {
    files?: number
    oxc_files?: number
    parse_failures?: number
    resolved_edges?: number
    resolve_ms?: number
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function unzip(repoRoot: string, args: string[], input?: Buffer): string {
  const result = spawnSync("unzip", args, {
    cwd: repoRoot,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `unzip ${args.join(" ")} failed`)
  return result.stdout
}

function zipList(repoRoot: string, path: string): string[] {
  return unzip(repoRoot, ["-Z1", path]).trim().split("\n").filter(Boolean)
}

function zipText(repoRoot: string, path: string, entry: string): string {
  return unzip(repoRoot, ["-p", path, entry])
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function verifyReviewPackets(repoRoot: string, input: VerifyReviewPacketsInputV1 = {}): VerifyReviewPacketsResultV1 {
  const sourceZip = resolve(repoRoot, input.source_zip_path ?? "tribunus-source-review.zip")
  const irZip = resolve(repoRoot, input.ir_zip_path ?? "tribunus-gemini-ir.zip")

  expect(existsSync(sourceZip), `Missing ${sourceZip}`)
  expect(existsSync(irZip), `Missing ${irZip}`)

  const sourceEntries = zipList(repoRoot, sourceZip)
  expect(
    sourceEntries.includes("tribunus-source-review/repo/.omp/tools/_lib/review-export/source-graph.ts"),
    "source-review zip is missing source-graph.ts",
  )

  const moduleGraph = JSON.parse(zipText(repoRoot, irZip, "tribunus-gemini-ir/03_module_graph.json")) as {
    source_graph?: VerifyReviewPacketsResultV1["source_graph"]
  }
  const sourceGraph = moduleGraph.source_graph
  expect(sourceGraph, "IR module graph is missing source_graph")
  expect((sourceGraph.oxc_files ?? 0) > 0, "source_graph.oxc_files must be greater than zero")
  expect(
    (sourceGraph.parse_failures ?? 0) < (sourceGraph.files ?? 0),
    "source_graph.parse_failures must be less than source_graph.files",
  )
  expect((sourceGraph.resolved_edges ?? 0) > 0, "source_graph.resolved_edges must be greater than zero")
  expect((sourceGraph.resolve_ms ?? 0) > 0, "source_graph.resolve_ms must be greater than zero")

  const reviewFindings = zipText(repoRoot, irZip, "tribunus-gemini-ir/10_review_findings.json")
  expect(
    reviewFindings.includes("source_graph_oxc_contributes"),
    "10_review_findings.json is missing source_graph_oxc_contributes",
  )

  return {
    source_zip_sha256: sha256(sourceZip),
    ir_zip_sha256: sha256(irZip),
    source_zip_files: sourceEntries.length,
    source_graph: sourceGraph,
  }
}
