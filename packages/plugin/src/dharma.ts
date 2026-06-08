import crypto from "node:crypto"

export type DharmaDimension =
  | "publisher" | "reviewer" | "compute"
  | "collaboration" | "moderation" | "security"

export interface DharmaScore {
  dimension: DharmaDimension
  score: number  // 0-100
  confidence: number  // 0-1, how many data points
  lastUpdated: string
  decayRate: number  // points lost per day of inactivity
}

export interface DharmaProfile {
  publisherId: string
  scores: Record<DharmaDimension, DharmaScore>
  overallScore: number  // weighted average
  trustLane: "low_trust" | "high_trust"
  offenses: DharmaOffense[]
  contributions: DharmaContribution[]
}

export interface DharmaOffense {
  offenseId: string
  publisherId: string
  dimension: DharmaDimension
  severity: "minor" | "major" | "critical"
  description: string
  timestamp: string
  penalty: number  // score reduction
  appealable: boolean
}

export interface DharmaContribution {
  contributionId: string
  publisherId: string
  dimension: DharmaDimension
  type: string  // e.g. "plugin_published", "code_reviewed", "bug_found"
  weight: number
  timestamp: string
}

export interface TrustLaneConfig {
  lane: "low_trust" | "high_trust"
  minOverallScore: number
  maxCapabilitiesPerPlugin: number
  requiresManualReview: boolean
  cooldownPeriodHours: number  // between capability requests
  maxOffenses: number  // before auto-revocation
}

export const TRUST_LANES: Record<string, TrustLaneConfig> = {
  low_trust: {
    lane: "low_trust",
    minOverallScore: 0,
    maxCapabilitiesPerPlugin: 3,
    requiresManualReview: true,
    cooldownPeriodHours: 72,
    maxOffenses: 3,
  },
  high_trust: {
    lane: "high_trust",
    minOverallScore: 70,
    maxCapabilitiesPerPlugin: 20,
    requiresManualReview: false,
    cooldownPeriodHours: 1,
    maxOffenses: 10,
  },
}

// Weight vector for overall score computation
const DIMENSION_WEIGHTS: Record<DharmaDimension, number> = {
  publisher: 0.15,
  reviewer: 0.15,
  compute: 0.20,
  collaboration: 0.20,
  moderation: 0.15,
  security: 0.15,
}

const ALL_DIMENSIONS: DharmaDimension[] = [
  "publisher", "reviewer", "compute", "collaboration", "moderation", "security",
]

export interface DharmaService {
  /** Compute dharma profile from event history */
  computeProfile(publisherId: string): Promise<DharmaProfile>

  /** Record a contribution event */
  recordContribution(contribution: Omit<DharmaContribution, "contributionId">): Promise<void>

  /** Record an offense event */
  recordOffense(offense: Omit<DharmaOffense, "offenseId">): Promise<void>

  /** Apply decay to stale scores */
  applyDecay(): Promise<void>

  /** Determine trust lane */
  determineTrustLane(profile: DharmaProfile): "low_trust" | "high_trust"

  /** Check if offense is slashable (critical severity) */
  isSlashable(offense: DharmaOffense): boolean
}

export class DharmaServiceImpl implements DharmaService {
  private profiles = new Map<string, DharmaProfile>()

  async computeProfile(publisherId: string): Promise<DharmaProfile> {
    let profile = this.profiles.get(publisherId)
    if (!profile) {
      profile = this.createEmptyProfile(publisherId)
      this.profiles.set(publisherId, profile)
    }

    profile.overallScore = this.computeWeightedOverall(profile.scores)
    profile.trustLane = this.determineTrustLane(profile)
    return profile
  }

  async recordContribution(
    contribution: Omit<DharmaContribution, "contributionId">,
  ): Promise<void> {
    let profile = this.profiles.get(contribution.publisherId)
    if (!profile) {
      profile = this.createEmptyProfile(contribution.publisherId)
      this.profiles.set(contribution.publisherId, profile)
    }

    const entry: DharmaContribution = {
      ...contribution,
      contributionId: crypto.randomUUID(),
    }
    profile.contributions.push(entry)

    const dimScore = profile.scores[contribution.dimension]
    const scoreDelta = Math.min(contribution.weight, 20)
    dimScore.score = Math.min(100, dimScore.score + scoreDelta)
    dimScore.confidence = Math.min(1, dimScore.confidence + (1 - dimScore.confidence) * 0.1)
    dimScore.lastUpdated = new Date().toISOString()

    profile.overallScore = this.computeWeightedOverall(profile.scores)
  }

  async recordOffense(
    offense: Omit<DharmaOffense, "offenseId">,
  ): Promise<void> {
    let profile = this.profiles.get(offense.publisherId)
    if (!profile) {
      profile = this.createEmptyProfile(offense.publisherId)
      this.profiles.set(offense.publisherId, profile)
    }

    const entry: DharmaOffense = {
      ...offense,
      offenseId: crypto.randomUUID(),
    }
    profile.offenses.push(entry)

    const dimScore = profile.scores[offense.dimension]
    dimScore.score = Math.max(0, dimScore.score - offense.penalty)

    const severityFactor =
      offense.severity === "critical" ? 0.3
        : offense.severity === "major" ? 0.5
          : 0.7
    dimScore.confidence = dimScore.confidence * severityFactor
    dimScore.lastUpdated = new Date().toISOString()

    profile.overallScore = this.computeWeightedOverall(profile.scores)
    profile.trustLane = this.determineTrustLane(profile)
  }

  async applyDecay(): Promise<void> {
    const now = new Date()
    for (const profile of this.profiles.values()) {
      for (const dimension of ALL_DIMENSIONS) {
        const score = profile.scores[dimension]
        if (score.score <= 0) continue

        const lastUpdated = new Date(score.lastUpdated)
        const daysSinceUpdate = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24)
        if (daysSinceUpdate <= 0) continue

        const decay = Math.round(score.decayRate * daysSinceUpdate)
        score.score = Math.max(0, score.score - decay)
        score.lastUpdated = now.toISOString()
      }

      profile.overallScore = this.computeWeightedOverall(profile.scores)
      profile.trustLane = this.determineTrustLane(profile)
    }
  }

  determineTrustLane(profile: DharmaProfile): "low_trust" | "high_trust" {
    const highTrustConfig = TRUST_LANES.high_trust
    const activeCritical = profile.offenses.filter(o => o.severity === "critical").length

    if (profile.overallScore >= highTrustConfig.minOverallScore
      && profile.offenses.length <= highTrustConfig.maxOffenses
      && activeCritical === 0) {
      return "high_trust"
    }

    return "low_trust"
  }

  isSlashable(offense: DharmaOffense): boolean {
    return offense.severity === "critical"
  }

  // ── Private ──

  private createEmptyProfile(publisherId: string): DharmaProfile {
    const now = new Date().toISOString()

    const scores = {} as Record<DharmaDimension, DharmaScore>
    for (const dim of ALL_DIMENSIONS) {
      scores[dim] = {
        dimension: dim,
        score: 50,
        confidence: 0.1,
        lastUpdated: now,
        decayRate: dim === "compute" ? 2 : 1,
      }
    }

    return {
      publisherId,
      scores,
      overallScore: this.computeWeightedOverall(scores),
      trustLane: "low_trust",
      offenses: [],
      contributions: [],
    }
  }

  private computeWeightedOverall(
    scores: Record<DharmaDimension, DharmaScore>,
  ): number {
    let weighted = 0
    for (const dim of ALL_DIMENSIONS) {
      weighted += scores[dim].score * DIMENSION_WEIGHTS[dim]
    }
    return Math.round(weighted * 10) / 10
  }
}
