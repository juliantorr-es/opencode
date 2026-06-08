import type * as NodeOs from "node:os"

// ── Pressure Monitor ──────────────────────────────────────

/**
 * Runtime pressure monitor that tracks system health signals and can
 * trigger adaptive throttling of the tool scheduler.
 *
 * Monitors: event loop lag, memory pressure, queue latency, heartbeat delays.
 * Policy: additive-increase/multiplicative-decrease on heavy concurrency.
 */

export type PressureLevel = "idle" | "normal" | "elevated" | "high" | "critical"

export interface PressureSnapshot {
  level: PressureLevel
  eventLoopLagMs: number
  memoryPressure: number // 0.0 - 1.0, fraction of used memory
  queueDepth: number
  queueLatencyMs: number
  cpuHeavyActive: number
  ioHeavyActive: number
  timestamp: number
}

export interface PressureMonitor {
  /** Take a one-shot snapshot of current pressure. */
  snapshot(): PressureSnapshot
  /** Start periodic monitoring. Returns a stop function. */
  start(intervalMs: number, onPressure: (snapshot: PressureSnapshot) => void): () => void
  /** Report current active job counts from the scheduler. */
  reportActiveJobs(cpuHeavy: number, ioHeavy: number): void
  /** Report current queue depth and average latency from the scheduler. */
  reportQueueState(depth: number, avgLatencyMs: number): void
  dispose(): void
}

export function createPressureMonitor(): PressureMonitor {
  let cpuHeavyActive = 0
  let ioHeavyActive = 0
  let queueDepth = 0
  let queueLatencyMs = 0

  function measureEventLoopLag(): number {
    // Measure elapsed wall-clock time minus expected spin duration.
    // If the event loop was blocked, Date.now() lags behind performance.now(),
    // revealing how long this tick was delayed.
    const start = Date.now()
    const t0 = performance.now()
    // Busy-wait long enough for a blocked event loop to show lag
    while (performance.now() - t0 < 5) {
      /* spin */
    }
    return Math.max(0, Date.now() - start - 5)
  }

  function measureMemoryPressure(): number {
    try {
      const os = require("node:os") as typeof NodeOs
      const total = os.totalmem()
      const free = os.freemem()
      return 1 - free / total
    } catch {
      // Unknown runtime — assume moderate pressure
      return 0.5
    }
  }

  function classifyLevel(lag: number, mem: number, qDepth: number): PressureLevel {
    if (lag > 200 || mem > 0.95 || qDepth > 100) return "critical"
    if (lag > 100 || mem > 0.85 || qDepth > 50) return "high"
    if (lag > 40 || mem > 0.70 || qDepth > 20) return "elevated"
    if (lag > 10 || mem > 0.50 || qDepth > 5) return "normal"
    return "idle"
  }

  function snapshot(): PressureSnapshot {
    const lag = measureEventLoopLag()
    const mem = measureMemoryPressure()
    const level = classifyLevel(lag, mem, queueDepth)
    return {
      level,
      eventLoopLagMs: lag,
      memoryPressure: mem,
      queueDepth,
      queueLatencyMs,
      cpuHeavyActive,
      ioHeavyActive,
      timestamp: Date.now(),
    }
  }

  function start(intervalMs: number, onPressure: (snapshot: PressureSnapshot) => void): () => void {
    const timer = setInterval(() => {
      onPressure(snapshot())
    }, intervalMs)
    return () => clearInterval(timer)
  }

  function reportActiveJobs(cpu: number, io: number): void {
    cpuHeavyActive = cpu
    ioHeavyActive = io
  }

  function reportQueueState(depth: number, avgLatency: number): void {
    queueDepth = depth
    queueLatencyMs = avgLatency
  }

  function dispose(): void {
    // Placeholder for future cleanup (e.g. abort controller, async timers)
  }

  return { snapshot, start, reportActiveJobs, reportQueueState, dispose }
}

// ── Adaptive Throttle ─────────────────────────────────────

/**
 * Concurrency limits that the scheduler respects for each resource class
 * and for the total agent count.
 */
export interface AdaptiveLimits {
  cpuHeavy: number
  ioHeavy: number
  searchMedium: number
  network: number
  maxAgents: number
}

/**
 * Compute safe concurrency limits given the current pressure snapshot,
 * the profile max (upper bound never exceeded), and the current limits
 * (used for AIMD adjustment).
 *
 * Additive-increase / multiplicative-decrease:
 * - Idle:          restore toward profile max, step +2/+4 per tick
 * - Normal:        gently increase toward profile max, step +1/+2 per tick
 * - Elevated:      hold current — neither increase nor decrease
 * - High:          halve immediately (floor 1; maxAgents floor 2)
 * - Critical:      quarter cpu_heavy, third search/agents, halve io/network
 */
export function computeAdaptiveLimits(
  pressure: PressureSnapshot,
  profileMax: AdaptiveLimits,
  current: AdaptiveLimits,
): AdaptiveLimits {
  switch (pressure.level) {
    case "critical":
      return {
        cpuHeavy: Math.max(1, Math.floor(current.cpuHeavy / 4)),
        ioHeavy: Math.max(1, Math.floor(current.ioHeavy / 2)),
        searchMedium: Math.max(1, Math.floor(current.searchMedium / 3)),
        network: Math.max(1, Math.floor(current.network / 2)),
        maxAgents: Math.max(1, Math.floor(current.maxAgents / 3)),
      }
    case "high":
      return {
        cpuHeavy: Math.max(1, Math.floor(current.cpuHeavy / 2)),
        ioHeavy: Math.max(1, Math.floor(current.ioHeavy / 2)),
        searchMedium: Math.max(1, Math.floor(current.searchMedium / 2)),
        network: Math.max(2, Math.floor(current.network / 2)),
        maxAgents: Math.max(2, Math.floor(current.maxAgents / 2)),
      }
    case "elevated":
      // Hold current — neither increase nor decrease
      return { ...current }
    case "normal":
      // Gently increase toward profile max
      return {
        cpuHeavy: Math.min(profileMax.cpuHeavy, current.cpuHeavy + 1),
        ioHeavy: Math.min(profileMax.ioHeavy, current.ioHeavy + (current.ioHeavy < profileMax.ioHeavy ? 1 : 0)),
        searchMedium: Math.min(profileMax.searchMedium, current.searchMedium + 2),
        network: Math.min(profileMax.network, current.network + 2),
        maxAgents: Math.min(profileMax.maxAgents, current.maxAgents + 1),
      }
    case "idle":
      // Restore toward profile max at accelerated pace
      return {
        cpuHeavy: Math.min(profileMax.cpuHeavy, current.cpuHeavy + 2),
        ioHeavy: Math.min(profileMax.ioHeavy, current.ioHeavy + 1),
        searchMedium: Math.min(profileMax.searchMedium, current.searchMedium + 4),
        network: Math.min(profileMax.network, current.network + 4),
        maxAgents: Math.min(profileMax.maxAgents, current.maxAgents + 2),
      }
  }
}
