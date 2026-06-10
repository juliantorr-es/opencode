/**
 * Artifact Retention — policies for artifact lifecycle management.
 */

import type { RetentionPolicy } from "./types.js"

export interface RetentionRule {
  policy: RetentionPolicy
  autoDeleteAfterDays: number | null
  allowAutoDelete: boolean
  description: string
}

export const RETENTION_POLICIES: Record<RetentionPolicy, RetentionRule> = {
  permanent: {
    policy: "permanent",
    autoDeleteAfterDays: null,
    allowAutoDelete: false,
    description: "Never automatically deleted. Manual deletion only.",
  },
  mission_evidence: {
    policy: "mission_evidence",
    autoDeleteAfterDays: null,
    allowAutoDelete: false,
    description: "Mission evidence — retained indefinitely. Manual deletion only.",
  },
  cache: {
    policy: "cache",
    autoDeleteAfterDays: 30,
    allowAutoDelete: true,
    description: "Cache artifacts may be evicted after 30 days. Registry records preserved.",
  },
  temporary: {
    policy: "temporary",
    autoDeleteAfterDays: 7,
    allowAutoDelete: true,
    description: "Temporary artifacts with explicit expiry. Auto-deleted after 7 days.",
  },
  imported_external: {
    policy: "imported_external",
    autoDeleteAfterDays: null,
    allowAutoDelete: false,
    description: "Imported from external source. Manual deletion only.",
  },
}

export function getRetentionPolicy(policy: RetentionPolicy): RetentionRule {
  return RETENTION_POLICIES[policy]
}

export function isExpired(createdAt: string, policy: RetentionPolicy): boolean {
  const rule = RETENTION_POLICIES[policy]
  if (rule.autoDeleteAfterDays === null) return false
  const created = new Date(createdAt).getTime()
  const now = Date.now()
  return now - created > rule.autoDeleteAfterDays * 24 * 60 * 60 * 1000
}
