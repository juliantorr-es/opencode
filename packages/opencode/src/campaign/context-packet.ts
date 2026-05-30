// ── CampaignContextPacket — LLM Context Assembly ─────────────
//
// Builds agent-facing context packets from campaign state. The
// context packet is a structured projection that includes the
// campaign and lane states, recent events, active gates, and
// artifact hashes — designed for direct injection into LLM
// context windows.
// ──────────────────────────────────────────────────────────────

import type { CampaignEventPayload } from "./campaign-event"
import type { CampaignState, LaneState } from "./types"

// ── Types ──────────────────────────────────────────────────

export interface ActiveGate {
  readonly gate: string
  readonly status: "pending" | "passed" | "failed"
  readonly evaluatedAt: string
}

export interface LaneContext {
  readonly laneId: string
  readonly scope: string
  readonly currentState: string
  readonly role: string | null
  readonly dependencyIds: readonly string[]
  readonly artifactHashes: readonly string[]
  readonly eventCount: number
}

export interface CampaignContextPacket {
  readonly campaignId: string
  readonly campaignState: string
  readonly goal: string
  readonly lanes: readonly LaneContext[]
  readonly recentEvents: readonly CampaignEventPayload[]
  readonly activeGates: readonly ActiveGate[]
  readonly totalEvents: number
  readonly projectedAt: string
}

// ── Builders ───────────────────────────────────────────────

/**
 * Build a CampaignContextPacket from campaign state and events.
 * The packet is a structured projection for LLM context injection.
 */
export function buildContextPacket(
  campaignId: string,
  goal: string,
  campaignState: CampaignState,
  lanes: readonly {
    readonly id: string
    readonly scope: string
    readonly currentState: string
    readonly role: string | null
    readonly dependencyIds: readonly string[]
    readonly binderArtifactHashes: readonly string[]
    readonly eventCount: number
  }[],
  events: readonly CampaignEventPayload[],
  gates?: readonly ActiveGate[],
): CampaignContextPacket {
  const recentEvents = events.slice(-20) // last 20 events for context

  return {
    campaignId,
    campaignState: campaignState as string,
    goal,
    lanes: lanes.map((l) => ({
      laneId: l.id,
      scope: l.scope,
      currentState: l.currentState,
      role: l.role,
      dependencyIds: l.dependencyIds,
      artifactHashes: l.binderArtifactHashes,
      eventCount: l.eventCount,
    })),
    recentEvents,
    activeGates: gates ?? [],
    totalEvents: events.length,
    projectedAt: new Date().toISOString(),
  }
}

/**
 * Format a CampaignContextPacket as Markdown for LLM injection.
 */
export function formatPacketForLLM(packet: CampaignContextPacket): string {
  const lines: string[] = [
    `# Campaign Context: ${packet.campaignId}`,
    ``,
    `- **Campaign State**: ${packet.campaignState}`,
    `- **Goal**: ${packet.goal}`,
    `- **Total Events**: ${packet.totalEvents}`,
    `- **Lanes**: ${packet.lanes.length}`,
    `- **Active Gates**: ${packet.activeGates.length}`,
    ``,
    `## Lanes`,
    ``,
  ]

  for (const lane of packet.lanes) {
    lines.push(`### ${lane.laneId}`)
    lines.push(`- **State**: ${lane.currentState}`)
    lines.push(`- **Scope**: ${lane.scope}`)
    lines.push(`- **Role**: ${lane.role ?? "none"}`)
    lines.push(`- **Dependencies**: ${lane.dependencyIds.join(", ") || "none"}`)
    lines.push(`- **Artifacts**: ${lane.artifactHashes.length}`)
    lines.push(`- **Events**: ${lane.eventCount}`)
    lines.push(``)
  }

  if (packet.activeGates.length > 0) {
    lines.push(`## Active Gates`)
    lines.push(``)
    for (const gate of packet.activeGates) {
      lines.push(`- **${gate.gate}**: ${gate.status} (${gate.evaluatedAt})`)
    }
    lines.push(``)
  }

  if (packet.recentEvents.length > 0) {
    lines.push(`## Recent Events (${packet.recentEvents.length})`)
    lines.push(``)
    for (const evt of packet.recentEvents) {
      lines.push(`- \`${evt.eventType}\` @ ${evt.ts} ${evt.laneId ? `[${evt.laneId}]` : ""}`)
    }
    lines.push(``)
  }

  lines.push(`---`)
  lines.push(`*Projected at ${packet.projectedAt}*`)

  return lines.join("\n")
}

export * as CampaignContextPacket from "."
