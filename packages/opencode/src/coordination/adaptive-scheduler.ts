/**
 * Adaptive Scheduler — wraps a base ToolScheduler with capacity profile limits
 * and dynamic pressure-based throttling.
 */

import type { ToolScheduler, ToolJob, ToolJobResult, ToolJobState, BackpressureState, ResourceClass } from "./tool-scheduler"
import type { CapacityProfile, SchedulerLimits } from "./capacity-profile"
import { createPressureMonitor, computeAdaptiveLimits, type PressureMonitor, type PressureSnapshot, type AdaptiveLimits } from "./pressure-monitor"

export interface AdaptiveSchedulerOptions {
  baseScheduler: ToolScheduler
  profile: CapacityProfile
  /** How often to check pressure (ms). Default 5000. */
  pressureCheckIntervalMs?: number
  /** Called when limits change due to pressure. */
  onLimitsChanged?: (limits: AdaptiveLimits) => void
}

export function createAdaptiveScheduler(opts: AdaptiveSchedulerOptions): ToolScheduler & { getAdaptiveLimits(): AdaptiveLimits; getPressure(): PressureSnapshot } {
  const { baseScheduler, profile, onLimitsChanged } = opts
  const monitor = createPressureMonitor()

  const profileMax: AdaptiveLimits = {
    cpuHeavy: profile.scheduler.resourceLimits.cpu_heavy ?? 2,
    ioHeavy: profile.scheduler.resourceLimits.io_heavy ?? 1,
    searchMedium: profile.scheduler.resourceLimits.search_medium ?? 4,
    network: profile.scheduler.resourceLimits.network ?? 8,
    maxAgents: profile.scheduler.maxAgents,
  }

  let currentLimits: AdaptiveLimits = { ...profileMax }

  // Periodic pressure monitoring
  const stopMonitor = monitor.start(opts.pressureCheckIntervalMs ?? 5000, (snap: PressureSnapshot) => {
    const newLimits = computeAdaptiveLimits(snap, profileMax, currentLimits)
    if (
      newLimits.cpuHeavy !== currentLimits.cpuHeavy ||
      newLimits.ioHeavy !== currentLimits.ioHeavy ||
      newLimits.maxAgents !== currentLimits.maxAgents
    ) {
      currentLimits = newLimits
      onLimitsChanged?.(currentLimits)
    }
  })

  async function submit(input: Omit<ToolJob, "id" | "submittedAt" | "attempt">): Promise<{ jobId: string; accepted: boolean; reason?: string }> {
    // Check agent cap
    const allJobs = await baseScheduler.listJobs(input.projectId)
    const activeAgents = new Set(allJobs.filter(j => j.status !== "completed" && j.status !== "failed" && j.status !== "cancelled").map(j => j.job.agentId)).size
    if (activeAgents >= currentLimits.maxAgents) {
      return { jobId: "", accepted: false, reason: `Agent limit reached (${currentLimits.maxAgents})` }
    }

    // Check resource class limit
    const rc = input.resourceClass
    const limit = getResourceLimit(rc)
    const active = allJobs.filter(j => j.status === "running" && j.job.resourceClass === rc).length
    if (active >= limit) {
      // Queue it
      return baseScheduler.submit(input)
    }

    return baseScheduler.submit(input)
  }

  function getResourceLimit(rc: ResourceClass): number {
    switch (rc) {
      case "cpu_heavy": return currentLimits.cpuHeavy
      case "io_heavy": return currentLimits.ioHeavy
      case "search_medium": return currentLimits.searchMedium
      case "network": return currentLimits.network
      case "exclusive_repo": return 1
      default: return 32
    }
  }

  // Update monitor with current state
  async function syncPressure() {
    const allJobs = await baseScheduler.listJobs()
    const cpu = allJobs.filter(j => j.status === "running" && j.job.resourceClass === "cpu_heavy").length
    const io = allJobs.filter(j => j.status === "running" && j.job.resourceClass === "io_heavy").length
    const queued = allJobs.filter(j => j.status === "pending" || j.status === "admitted").length
    monitor.reportActiveJobs(cpu, io)
    monitor.reportQueueState(queued, 0)
  }

  function getAdaptiveLimits(): AdaptiveLimits {
    return { ...currentLimits }
  }

  function getPressure(): PressureSnapshot {
    return monitor.snapshot()
  }

  const adaptiveScheduler: ToolScheduler & { getAdaptiveLimits(): AdaptiveLimits; getPressure(): PressureSnapshot } = {
    submit,
    awaitResult: baseScheduler.awaitResult.bind(baseScheduler),
    cancel: baseScheduler.cancel.bind(baseScheduler),
    getState: baseScheduler.getState.bind(baseScheduler),
    listJobs: baseScheduler.listJobs.bind(baseScheduler),
    backpressure: baseScheduler.backpressure.bind(baseScheduler),
    canAdmit: baseScheduler.canAdmit.bind(baseScheduler),
    reap: baseScheduler.reap.bind(baseScheduler),
    dispose: async () => {
      stopMonitor()
      monitor.dispose()
      await baseScheduler.dispose()
    },
    getAdaptiveLimits,
    getPressure,
  }

  // Initial sync
  syncPressure()

  return adaptiveScheduler
}
