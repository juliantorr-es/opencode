import { Effect, Context, Schema } from "effect"

// ── Data types ──────────────────────────────────────────────────────────

export const WeightCategory = Schema.Struct({
  name: Schema.String,
  weight: Schema.Number,
  maxScore: Schema.Number,
})
export type WeightCategory = typeof WeightCategory.Type

export const WeightRubric = Schema.Struct({
  categories: Schema.Array(WeightCategory),
  totalWeight: Schema.Number,
})
export type WeightRubric = typeof WeightRubric.Type

export const ScoredCategory = Schema.Struct({
  name: Schema.String,
  weight: Schema.Number,
  maxScore: Schema.Number,
  score: Schema.Number,
  weightedScore: Schema.Number,
})
export type ScoredCategory = typeof ScoredCategory.Type

export const ScoreResult = Schema.Struct({
  total: Schema.Number,
  perCategory: Schema.Array(ScoredCategory),
})
export type ScoreResult = typeof ScoreResult.Type

// ── Default categories ──────────────────────────────────────────────────

const DEFAULT_CATEGORIES: WeightCategory[] = [
  { name: "boundary", weight: 25, maxScore: 100 },
  { name: "coupling", weight: 20, maxScore: 100 },
  { name: "safety", weight: 20, maxScore: 100 },
  { name: "reversibility", weight: 10, maxScore: 100 },
  { name: "surface_area", weight: 10, maxScore: 100 },
  { name: "convention", weight: 10, maxScore: 100 },
  { name: "resilience", weight: 5, maxScore: 100 },
]

// ── Service interface ───────────────────────────────────────────────────

export interface Interface {
  readonly defaultRubric: () => WeightRubric
  readonly buildRubric: (categories: WeightCategory[]) => WeightRubric
  readonly addCategory: (
    rubric: WeightRubric,
    name: string,
    weight: number,
    maxScore: number,
  ) => WeightRubric
  readonly removeCategory: (rubric: WeightRubric, name: string) => WeightRubric
  readonly calculateScore: (rubric: WeightRubric, scores: Record<string, number>) => ScoreResult
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ReviewWeight") {}

// ── Layer ───────────────────────────────────────────────────────────────

export const layer = Effect.sync(() =>
  Service.of({
    defaultRubric: () => ({
      categories: [...DEFAULT_CATEGORIES],
      totalWeight: DEFAULT_CATEGORIES.reduce((sum, c) => sum + c.weight, 0),
    }),

    buildRubric: (categories: WeightCategory[]) => ({
      categories: [...categories],
      totalWeight: categories.reduce((sum, c) => sum + c.weight, 0),
    }),

    addCategory: (
      rubric: WeightRubric,
      name: string,
      weight: number,
      maxScore: number,
    ) => {
      const filtered = rubric.categories.filter((c) => c.name !== name)
      const updated = [...filtered, { name, weight, maxScore }]
      return {
        categories: updated,
        totalWeight: updated.reduce((sum, c) => sum + c.weight, 0),
      }
    },

    removeCategory: (rubric: WeightRubric, name: string) => {
      const updated = rubric.categories.filter((c) => c.name !== name)
      return {
        categories: updated,
        totalWeight: updated.reduce((sum, c) => sum + c.weight, 0),
      }
    },

    calculateScore: (rubric: WeightRubric, scores: Record<string, number>): ScoreResult => {
      const perCategory: ScoredCategory[] = rubric.categories.map((cat) => {
        const raw = scores[cat.name] ?? 0
        const capped = Math.min(raw, cat.maxScore)
        const fraction = rubric.totalWeight > 0 ? cat.weight / rubric.totalWeight : 0
        return {
          name: cat.name,
          weight: cat.weight,
          maxScore: cat.maxScore,
          score: capped,
          weightedScore: Math.round((capped / cat.maxScore) * fraction * 100 * 100) / 100,
        }
      })
      return {
        total: perCategory.reduce((sum, c) => sum + c.weightedScore, 0),
        perCategory,
      }
    },
  }),
)

export * as ReviewWeight from "./weight"
