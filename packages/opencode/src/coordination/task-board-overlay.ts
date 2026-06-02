/**
 * Task Board Live Overlay — merges durable projection baseline with Valkey/event live state.
 *
 * Durable truth: DB projection tables (agent status, task state, sessions)
 * Live overlay:   RealtimeEventBridge agent heartbeats, tool jobs, backpressure
 *
 * The task board renders: baseline + overlay = immediate state
 * On restart: overlay is empty, baseline is authoritative
 */

import type { RealtimeEventBridge, RealtimeEvent } from "./realtime-event-bridge"

export interface AgentOverlay {
  agentId: string
  status: "idle" | "running" | "blocked" | "completed" | "failed"
  currentTool?: string
  currentJobId?: string
  lastHeartbeatAt?: number
  blockedReason?: string
  progress?: string
}

export interface ToolJobOverlay {
  jobId: string
  toolName: string
  status: "queued" | "running" | "completed" | "failed"
  agentId: string
  resourceClass: string
  startedAt?: number
  durationMs?: number
}

export interface TaskBoardOverlay {
  agents: Map<string, AgentOverlay>
  toolJobs: Map<string, ToolJobOverlay>
  backpressure: {
    queued: number
    running: number
    throttled: boolean
  }
  lastUpdated: number
}

export function createTaskBoardOverlay(bridge: RealtimeEventBridge) {
  const state: TaskBoardOverlay = {
    agents: new Map(),
    toolJobs: new Map(),
    backpressure: { queued: 0, running: 0, throttled: false },
    lastUpdated: Date.now(),
  }

  function snapshot(): TaskBoardOverlay {
    return { ...state, agents: new Map(state.agents), toolJobs: new Map(state.toolJobs) }
  }

  // Subscribe to all events
  bridge.on("*", (event: RealtimeEvent) => {
    state.lastUpdated = event.timestamp

    switch (event.kind) {
      case "agent.started":
      case "agent.heartbeat": {
        const agentId = event.agentId ?? event.payload.agentId as string
        if (!agentId) return
        state.agents.set(agentId, {
          agentId,
          status: (event.payload.status as AgentOverlay["status"]) ?? "running",
          currentTool: event.payload.toolName as string | undefined,
          currentJobId: event.jobId,
          lastHeartbeatAt: event.timestamp,
          progress: event.payload.progress as string | undefined,
        })
        break
      }
      case "agent.blocked": {
        const agentId = event.agentId ?? event.payload.agentId as string
        if (!agentId) return
        state.agents.set(agentId, {
          agentId,
          status: "blocked",
          blockedReason: event.payload.reason as string,
          lastHeartbeatAt: event.timestamp,
        })
        break
      }
      case "agent.completed":
      case "agent.failed": {
        const agentId = event.agentId ?? event.payload.agentId as string
        if (!agentId) return
        state.agents.set(agentId, {
          agentId,
          status: event.kind === "agent.completed" ? "completed" : "failed",
          lastHeartbeatAt: event.timestamp,
        })
        break
      }
      case "tool.job.submitted": {
        const jobId = event.jobId ?? event.payload.jobId as string
        if (!jobId) return
        state.toolJobs.set(jobId, {
          jobId,
          toolName: event.payload.toolName as string,
          status: "queued",
          agentId: event.agentId ?? "unknown",
          resourceClass: event.payload.resourceClass as string,
        })
        state.backpressure.queued++
        break
      }
      case "tool.job.started": {
        const jobId = event.jobId ?? event.payload.jobId as string
        if (!jobId) return
        const existing = state.toolJobs.get(jobId)
        state.toolJobs.set(jobId, {
          ...existing,
          jobId,
          status: "running",
          startedAt: event.timestamp,
        } as ToolJobOverlay)
        state.backpressure.queued = Math.max(0, state.backpressure.queued - 1)
        state.backpressure.running++
        break
      }
      case "tool.job.completed":
      case "tool.job.failed":
      case "tool.job.cancelled": {
        const jobId = event.jobId ?? event.payload.jobId as string
        if (!jobId) return
        const existing = state.toolJobs.get(jobId)
        state.toolJobs.set(jobId, {
          ...existing,
          jobId,
          status: event.kind === "tool.job.completed" ? "completed" : "failed",
          durationMs: event.payload.durationMs as number,
        } as ToolJobOverlay)
        state.backpressure.running = Math.max(0, state.backpressure.running - 1)
        break
      }
      case "backpressure.changed": {
        state.backpressure.throttled = !!event.payload.throttled
        break
      }
    }
  })

  return { snapshot, state }
}
