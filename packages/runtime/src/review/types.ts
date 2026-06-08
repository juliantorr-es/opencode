// Review types — shared across comparison, weight, manifest

export interface ReviewSubject {
  type: "campaign" | "lane" | "artifact" | "plan"
  id: string
  version: string
}

export interface ReviewArtifact {
  path: string
  type: string
  sha256: string
}

export interface WeightCategory {
  name: string
  weight: number
  maxScore: number
}

export interface WeightRubric {
  categories: WeightCategory[]
  totalWeight: number
}

export interface ReviewVerdict {
  status: "passed" | "failed" | "inconclusive"
  score: number
  summary: string
}

export interface ReviewManifest {
  manifestVersion: string
  reviewId: string
  campaignId?: string
  laneId?: string
  subject: ReviewSubject
  artifacts: ReviewArtifact[]
  weight: WeightRubric
  comparison?: ComparisonResult
  verdict: ReviewVerdict
}

export interface DiffEntry {
  file: string
  type: "added" | "removed" | "modified"
  oldSha?: string
  newSha?: string
  linesAdded?: number
  linesRemoved?: number
}

export interface ComparisonResult {
  method: "diff" | "structural" | "semantic"
  baselineId: string
  targetId: string
  diffs: DiffEntry[]
}

export * as Review from "./types"
