import { Effect, Context, Layer, Schema, Option } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import path from "path"

// ── Domain type schemas ─────────────────────────────────────────────────

export const ReviewSubjectSchema = Schema.Struct({
  type: Schema.Literals(["campaign", "lane", "artifact", "plan"]),
  id: Schema.String,
  version: Schema.String,
})
export type ReviewSubject = typeof ReviewSubjectSchema.Type

export const ReviewArtifactSchema = Schema.Struct({
  path: Schema.String,
  type: Schema.String,
  sha256: Schema.String,
})
export type ReviewArtifact = typeof ReviewArtifactSchema.Type

export const WeightCategorySchema = Schema.Struct({
  name: Schema.String,
  weight: Schema.Number,
  maxScore: Schema.Number,
})
export type WeightCategory = typeof WeightCategorySchema.Type

export const WeightRubricSchema = Schema.Struct({
  categories: Schema.Array(WeightCategorySchema),
  totalWeight: Schema.Number,
})
export type WeightRubric = typeof WeightRubricSchema.Type

export const ReviewVerdictSchema = Schema.Struct({
  status: Schema.Literals(["passed", "failed", "inconclusive"]),
  score: Schema.Number,
  summary: Schema.String,
})
export type ReviewVerdict = typeof ReviewVerdictSchema.Type

export const DiffEntrySchema = Schema.Struct({
  file: Schema.String,
  type: Schema.Literals(["added", "removed", "modified"]),
  oldSha: Schema.optional(Schema.String),
  newSha: Schema.optional(Schema.String),
  linesAdded: Schema.optional(Schema.Finite),
  linesRemoved: Schema.optional(Schema.Finite),
})
export type DiffEntry = typeof DiffEntrySchema.Type

export const ComparisonResultSchema = Schema.Struct({
  method: Schema.Literals(["diff", "structural", "semantic"]),
  baselineId: Schema.String,
  targetId: Schema.String,
  diffs: Schema.Array(DiffEntrySchema),
})
export type ComparisonResult = typeof ComparisonResultSchema.Type

// ── Manifest schema ─────────────────────────────────────────────────────

export const ManifestSchema = Schema.Struct({
  manifestVersion: Schema.String,
  reviewId: Schema.String,
  campaignId: Schema.optional(Schema.String),
  laneId: Schema.optional(Schema.String),
  subject: ReviewSubjectSchema,
  artifacts: Schema.Array(ReviewArtifactSchema),
  weight: WeightRubricSchema,
  comparison: Schema.optional(ComparisonResultSchema),
  verdict: ReviewVerdictSchema,
})
export type Manifest = typeof ManifestSchema.Type

// ── Service interface ───────────────────────────────────────────────────

export interface Interface {
  readonly generateManifest: (input: {
    reviewId: string
    subject: ReviewSubject
    artifacts: ReviewArtifact[]
    weight: WeightRubric
    verdict: ReviewVerdict
    campaignId?: string
    laneId?: string
    comparison?: import("./types").ComparisonResult
  }) => Manifest
  readonly validateManifest: (manifest: unknown) => Effect.Effect<boolean, never, never>
  readonly writeManifest: (manifest: Manifest, filePath: string) => Effect.Effect<void, never, never>
  readonly readManifest: (filePath: string) => Effect.Effect<Manifest, never, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ReviewManifest") {}

// ── Schema for validation ───────────────────────────────────────────────

const ManifestValidationSchema = Schema.Struct({
  manifestVersion: Schema.String,
  reviewId: Schema.String,
  subject: Schema.Struct({
    type: Schema.Literals(["campaign", "lane", "artifact", "plan"]),
    id: Schema.String,
    version: Schema.String,
  }),
  artifacts: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      type: Schema.String,
      sha256: Schema.String,
    }),
  ),
  weight: Schema.Struct({
    categories: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        weight: Schema.Number,
        maxScore: Schema.Number,
      }),
    ),
    totalWeight: Schema.Number,
  }),
  verdict: Schema.Struct({
    status: Schema.Literals(["passed", "failed", "inconclusive"]),
    score: Schema.Number,
    summary: Schema.String,
  }),
})

// ── Layer ───────────────────────────────────────────────────────────────

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const generateManifest: Interface["generateManifest"] = (input): Manifest => ({
      manifestVersion: "1.0.0",
      reviewId: input.reviewId,
      campaignId: input.campaignId,
      laneId: input.laneId,
      subject: input.subject,
      artifacts: input.artifacts,
      weight: input.weight,
      comparison: input.comparison as any,
      verdict: input.verdict,
    })

    const validateManifest: Interface["validateManifest"] = (manifest: unknown) =>
      Effect.gen(function* () {
        const decoded = Schema.decodeUnknownOption(ManifestValidationSchema)(manifest)
        return decoded._tag === "Some"
      }).pipe(Effect.orDie)

    const writeManifest: Interface["writeManifest"] = (manifest: Manifest, filePath: string) =>
      Effect.gen(function* () {
        yield* fs.ensureDir(path.dirname(filePath))
        yield* fs.writeJson(filePath, manifest)
      }).pipe(Effect.orDie)

    const readManifest: Interface["readManifest"] = (filePath: string) =>
      Effect.gen(function* () {
        const data = yield* fs.readJson(filePath)
        const decoded = Schema.decodeUnknownOption(ManifestSchema)(data)
        if (Option.isNone(decoded)) {
          throw new Error(`Invalid review manifest at ${filePath}`)
        }
        return decoded.value as Manifest
      }).pipe(Effect.orDie)

    return Service.of({ generateManifest, validateManifest, writeManifest, readManifest })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as ReviewManifest from "./manifest"
