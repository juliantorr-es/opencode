import { describe, test, expect } from "bun:test"
import {
  collectStaticInventory,
  classifyMemoryClass,
  deriveSchedulerLimits,
  estimateProfile,
  type CapacityProfile,
} from "../../src/coordination/capacity-profile"
import { computeAdaptiveLimits, createPressureMonitor, type AdaptiveLimits } from "../../src/coordination/pressure-monitor"

describe("CapacityProfile", () => {
  test("collectStaticInventory returns valid machine info", () => {
    const machine = collectStaticInventory()
    expect(machine.platform).toBeTruthy()
    expect(machine.cpuCount).toBeGreaterThan(0)
    expect(machine.totalMemoryBytes).toBeGreaterThan(0)
    expect(machine.memoryClass).toMatch(/low|medium|high|extreme/)
  })

  test("classifyMemoryClass maps bytes to classes", () => {
    expect(classifyMemoryClass(8 * 1024 ** 3)).toBe("low")
    expect(classifyMemoryClass(16 * 1024 ** 3)).toBe("medium")
    expect(classifyMemoryClass(32 * 1024 ** 3)).toBe("high")
    expect(classifyMemoryClass(96 * 1024 ** 3)).toBe("extreme")
  })

  test("estimateProfile generates valid profile", () => {
    const profile = estimateProfile()
    expect(profile.version).toBe(1)
    expect(profile.confidence).toBe("estimated")
    expect(profile.scheduler.maxAgents).toBeGreaterThan(0)
    expect(profile.scheduler.resourceLimits.cpu_heavy).toBeGreaterThan(0)
    expect(profile.scheduler.resourceLimits.exclusive_repo).toBe(1)
  })

  test("different memory classes produce different limits", () => {
    const low = estimateProfileWithMemory(8)
    const high = estimateProfileWithMemory(64)

    // Higher memory = more agents
    expect(high.scheduler.maxAgents).toBeGreaterThan(low.scheduler.maxAgents)
    expect(high.scheduler.resourceLimits.cpu_heavy!).toBeGreaterThanOrEqual(low.scheduler.resourceLimits.cpu_heavy!)
  })

  test("exclusive_repo is always 1 regardless of memory", () => {
    const low = estimateProfileWithMemory(8)
    const extreme = estimateProfileWithMemory(128)
    expect(low.scheduler.resourceLimits.exclusive_repo).toBe(1)
    expect(extreme.scheduler.resourceLimits.exclusive_repo).toBe(1)
  })

  test("low memory class caps agents appropriately", () => {
    const profile = estimateProfileWithMemory(8)
    expect(profile.scheduler.maxAgents).toBeLessThanOrEqual(6)
    expect(profile.scheduler.resourceLimits.cpu_heavy).toBe(1)
  })
})

describe("PressureMonitor", () => {
  test("snapshot returns valid pressure data", () => {
    const monitor = createPressureMonitor()
    const snap = monitor.snapshot()
    expect(snap.level).toMatch(/idle|normal|elevated|high|critical/)
    expect(snap.timestamp).toBeGreaterThan(0)
    expect(snap.memoryPressure).toBeGreaterThanOrEqual(0)
    expect(snap.memoryPressure).toBeLessThanOrEqual(1)
  })

  test("periodic monitoring fires callbacks", (done) => {
    const monitor = createPressureMonitor()
    let fired = false
    const stop = monitor.start(100, (snap) => {
      fired = true
      stop()
      expect(snap.level).toBeTruthy()
      done()
    })
    // Safety cleanup
    setTimeout(() => { stop(); if (!fired) done() }, 2000)
  }, 3000)

  test("reportActiveJobs updates internal state", () => {
    const monitor = createPressureMonitor()
    monitor.reportActiveJobs(5, 2)
    const snap = monitor.snapshot()
    expect(snap.cpuHeavyActive).toBe(5)
    expect(snap.ioHeavyActive).toBe(2)
  })

  test("reportQueueState updates internal state", () => {
    const monitor = createPressureMonitor()
    monitor.reportQueueState(15, 200)
    const snap = monitor.snapshot()
    expect(snap.queueDepth).toBe(15)
    expect(snap.queueLatencyMs).toBe(200)
  })

  test("dispose is idempotent", () => {
    const monitor = createPressureMonitor()
    monitor.dispose()
    monitor.dispose() // should not throw
  })
})

describe("AdaptiveLimits", () => {
  const profileMax: AdaptiveLimits = {
    cpuHeavy: 4,
    ioHeavy: 2,
    searchMedium: 8,
    network: 12,
    maxAgents: 16,
  }

  test("critical pressure halves all limits", () => {
    const snap = makeSnapshot("critical")
    const result = computeAdaptiveLimits(snap, profileMax, profileMax)
    expect(result.cpuHeavy).toBeLessThanOrEqual(Math.floor(profileMax.cpuHeavy / 4))
    expect(result.maxAgents).toBeLessThanOrEqual(Math.floor(profileMax.maxAgents / 3))
    expect(result.cpuHeavy).toBeGreaterThanOrEqual(1)
    expect(result.ioHeavy).toBeGreaterThanOrEqual(1)
  })

  test("high pressure halves limits", () => {
    const snap = makeSnapshot("high")
    const result = computeAdaptiveLimits(snap, profileMax, profileMax)
    expect(result.cpuHeavy).toBeLessThanOrEqual(Math.floor(profileMax.cpuHeavy / 2))
    expect(result.cpuHeavy).toBeGreaterThanOrEqual(1)
  })

  test("elevated pressure holds current limits", () => {
    const current: AdaptiveLimits = { cpuHeavy: 2, ioHeavy: 1, searchMedium: 4, network: 6, maxAgents: 8 }
    const snap = makeSnapshot("elevated")
    const result = computeAdaptiveLimits(snap, profileMax, current)
    expect(result.cpuHeavy).toBe(2) // unchanged
  })

  test("normal pressure gently increases toward max", () => {
    const current: AdaptiveLimits = { cpuHeavy: 2, ioHeavy: 1, searchMedium: 4, network: 6, maxAgents: 8 }
    const snap = makeSnapshot("normal")
    const result = computeAdaptiveLimits(snap, profileMax, current)
    expect(result.cpuHeavy).toBeGreaterThanOrEqual(current.cpuHeavy)
    expect(result.cpuHeavy).toBeLessThanOrEqual(profileMax.cpuHeavy)
  })

  test("idle pressure restores toward max", () => {
    const current: AdaptiveLimits = { cpuHeavy: 2, ioHeavy: 1, searchMedium: 4, network: 6, maxAgents: 8 }
    const snap = makeSnapshot("idle")
    const result = computeAdaptiveLimits(snap, profileMax, current)
    expect(result.cpuHeavy).toBeGreaterThanOrEqual(current.cpuHeavy)
    expect(result.maxAgents).toBeGreaterThanOrEqual(current.maxAgents)
  })

  test("never drops below floor of 1", () => {
    const current: AdaptiveLimits = { cpuHeavy: 1, ioHeavy: 1, searchMedium: 1, network: 1, maxAgents: 1 }
    const snap = makeSnapshot("critical")
    const result = computeAdaptiveLimits(snap, profileMax, current)
    expect(result.cpuHeavy).toBeGreaterThanOrEqual(1)
    expect(result.ioHeavy).toBeGreaterThanOrEqual(1)
    expect(result.maxAgents).toBeGreaterThanOrEqual(1)
  })
})

// Helpers

function estimateProfileWithMemory(gb: number): CapacityProfile {
  const real = estimateProfile()
  const machine = {
    ...real.machine,
    memoryClass: classifyMemoryClass(gb * 1024 ** 3),
  }
  const scheduler = deriveSchedulerLimits(machine, real.scores)
  return { ...real, machine, scheduler }
}

function makeSnapshot(level: "idle" | "normal" | "elevated" | "high" | "critical") {
  return {
    level,
    eventLoopLagMs: level === "critical" ? 300 : level === "high" ? 150 : level === "elevated" ? 60 : 5,
    memoryPressure: level === "critical" ? 0.97 : level === "high" ? 0.88 : level === "elevated" ? 0.75 : 0.4,
    queueDepth: level === "critical" ? 200 : level === "high" ? 80 : level === "elevated" ? 30 : 3,
    queueLatencyMs: 0,
    cpuHeavyActive: 2,
    ioHeavyActive: 1,
    timestamp: Date.now(),
  }
}
