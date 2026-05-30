import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import DESCRIPTION from "./review-manifest.txt"

// ── Parameters ──────────────────────────────────────────────────────────

const Parameters = Schema.Struct({
  campaignId: Schema.optional(Schema.String).annotate({
    description: "Optional campaign identifier for the review",
  }),
  laneId: Schema.optional(Schema.String).annotate({
    description: "Optional lane identifier for the review",
  }),
  subjectType: Schema.Literals(["campaign", "lane", "artifact", "plan"]).annotate({
    description: "Type of the review subject",
  }),
  subjectId: Schema.String.annotate({
    description: "Identifier of the review subject",
  }),
  subjectVersion: Schema.String.annotate({
    description: "Version string of the review subject",
  }),
  artifactPaths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional list of artifact file paths to include",
  }),
  outputPath: Schema.optional(Schema.String).annotate({
    description: "Optional output path for the manifest JSON. Defaults to docs/json/opencode/reviews/<reviewId>.v1.json",
  }),
})

// ── SHA256 helper (sync) ────────────────────────────────────────────────

async function sha256Digest(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

// ── Tool definition ─────────────────────────────────────────────────────

export const ReviewManifestTool = Tool.define(
  "review_manifest",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const reviewId = `${params.subjectType}-${params.subjectId}-${params.subjectVersion}`

          // Build subject
          const subject = {
            type: params.subjectType,
            id: params.subjectId,
            version: params.subjectVersion,
          }

          // Gather artifact metadata
          const artifacts: Array<{ path: string; type: string; sha256: string }> = []
          if (params.artifactPaths) {
            for (const artifactPath of params.artifactPaths) {
              const resolved = path.isAbsolute(artifactPath)
                ? artifactPath
                : path.resolve(instance.directory, artifactPath)
              const exists = yield* fs.existsSafe(resolved)
              if (exists) {
                const content = yield* fs.readFileString(resolved)
                const sha256 = yield* Effect.promise(() => sha256Digest(content))
                const ext = path.extname(resolved).toLowerCase()
                artifacts.push({
                  path: resolved,
                  type: ext === ".json" ? "json" : ext === ".jsonl" ? "jsonl" : "file",
                  sha256,
                })
              }
            }
          }

          // Default weight rubric
          const weight = {
            categories: [
              { name: "boundary", weight: 25, maxScore: 100 },
              { name: "coupling", weight: 20, maxScore: 100 },
              { name: "safety", weight: 20, maxScore: 100 },
              { name: "reversibility", weight: 10, maxScore: 100 },
              { name: "surface_area", weight: 10, maxScore: 100 },
              { name: "convention", weight: 10, maxScore: 100 },
              { name: "resilience", weight: 5, maxScore: 100 },
            ],
            totalWeight: 100,
          }

          // Default verdict (no score yet — placeholder for campaign scoring)
          const verdict = {
            status: "inconclusive" as const,
            score: 0,
            summary: "Review manifest generated — pending scoring and comparison analysis",
          }

          // Build manifest
          const manifest = {
            manifestVersion: "1.0.0",
            reviewId,
            campaignId: params.campaignId,
            laneId: params.laneId,
            subject,
            artifacts,
            weight,
            verdict,
          }

          // Determine output path
          const outputPath = params.outputPath
            ? (path.isAbsolute(params.outputPath)
                ? params.outputPath
                : path.resolve(instance.directory, params.outputPath))
            : path.resolve(
                instance.directory,
                "docs",
                "json",
                "opencode",
                "reviews",
                `${reviewId}.v1.json`,
              )

          // Write manifest
          yield* fs.ensureDir(path.dirname(outputPath))
          yield* fs.writeJson(outputPath, manifest)

          return {
            title: "review_manifest",
            metadata: {
              reviewId,
              artifactCount: artifacts.length,
              outputPath,
            },
            output: JSON.stringify(
              {
                status: "created",
                reviewId,
                outputPath,
                artifactCount: artifacts.length,
                manifestVersion: "1.0.0",
                subject,
                verdict,
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as ReviewManifest from "./review-manifest"
