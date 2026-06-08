import type { ResourceClass } from "./tool-scheduler"
import type * as NodeOs from "node:os"
import type * as NodeChildProcess from "node:child_process"

// ── Capacity Profile ─────────────────────────────────────

export type MemoryClass = "low" | "medium" | "high" | "extreme"
export type ConfidenceLevel = "estimated" | "quick_profiled" | "deep_profiled"

export interface MachineInfo {
  platform: string
  arch: string
  cpuCount: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  memoryClass: MemoryClass
  /** Apple Silicon performance core count, if detectable */
  perfCores?: number
  /** Apple Silicon efficiency core count, if detectable */
  effCores?: number
}

export interface CapacityScores {
  /** Single-thread throughput score (relative, higher = faster) */
  cpuSingle: number
  /** Multi-thread throughput score */
  cpuMulti: number
  /** Estimated memory headroom in bytes */
  memoryHeadroom: number
  /** Sequential write throughput in MB/s */
  diskWriteMbSec: number
  /** Sequential read throughput in MB/s */
  diskReadMbSec: number
  /** Files per second for repo directory scan */
  repoScanFilesPerSec: number
  /** Valkey ping round-trip in ms, if available */
  valkeyPingMs?: number
  /** PGlite simple query latency in ms, if available */
  pglitePingMs?: number
}

export interface BackpressurePolicy {
  /** When queued jobs exceed this, policy changes */
  warnThreshold: number
  /** When queued jobs exceed this, reject low-priority */
  rejectThreshold: number
  /** Timeout multiplier for queued jobs (1.0 = default, 2.0 = double wait) */
  timeoutMultiplier: number
}

export interface SchedulerLimits {
  /** Maximum concurrent agents across all projects */
  maxAgents: number
  /** Maximum active subprocess workers */
  maxActiveSubprocesses: number
  /** Per-resource-class concurrency limits */
  resourceLimits: Partial<Record<ResourceClass, number>>
  /** Per-resource-class backpressure thresholds */
  queueBackpressure: Partial<Record<ResourceClass, BackpressurePolicy>>
}

export interface CapacityProfile {
  version: 1
  generatedAt: number
  machine: MachineInfo
  scores: CapacityScores
  scheduler: SchedulerLimits
  confidence: ConfidenceLevel
}

// ── Static Inventory ─────────────────────────────────────

/**
 * Read navigator.hardwareConcurrency across runtimes.
 * Browser/Electron renderer exposes it on navigator; Node.js sidecar
 * does not — fall back to os.cpus().length below.
 */
function readNavigatorCpuCount(): number | undefined {
  if (typeof navigator !== "undefined") {
    const concurrency = (navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency
    if (typeof concurrency === "number" && concurrency > 0) return concurrency
  }
  return undefined
}

export function collectStaticInventory(): MachineInfo {
  const platform = process.platform
  const arch = process.arch
  const navigatorCpus = readNavigatorCpuCount()

  // Node.js: use os module. Browser/Electron renderer: use navigator.
  // This module targets the sidecar (Node.js) context.
  let totalMemoryBytes = 0
  let freeMemoryBytes = 0
  let cpuCount = 4 // conservative fallback
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("node:os") as typeof NodeOs
    totalMemoryBytes = os.totalmem()
    freeMemoryBytes = os.freemem()
    cpuCount = navigatorCpus ?? os.cpus().length
  } catch {
    // Browser/unknown runtime: use navigator or estimate conservatively
    cpuCount = navigatorCpus ?? 4
    totalMemoryBytes = 8 * 1024 * 1024 * 1024 // 8GB default
    freeMemoryBytes = 4 * 1024 * 1024 * 1024
  }

  const memoryClass = classifyMemoryClass(totalMemoryBytes)

  let perfCores: number | undefined
  let effCores: number | undefined
  if (platform === "darwin") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require("node:child_process") as typeof NodeChildProcess
      const p = execSync("sysctl -n hw.perflevel0.physicalcpu", { encoding: "utf-8", timeout: 2000 })
      const e = execSync("sysctl -n hw.perflevel1.physicalcpu", { encoding: "utf-8", timeout: 2000 })
      const pVal = parseInt(p.trim(), 10)
      const eVal = parseInt(e.trim(), 10)
      if (!isNaN(pVal)) perfCores = pVal
      if (!isNaN(eVal)) effCores = eVal
    } catch {
      // sysctl unavailable or non-macOS
    }
  }

  return {
    platform,
    arch,
    cpuCount: perfCores != null && effCores != null ? perfCores + effCores : cpuCount,
    totalMemoryBytes,
    freeMemoryBytes,
    memoryClass,
    perfCores,
    effCores,
  }
}

export function classifyMemoryClass(bytes: number): MemoryClass {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb < 12) return "low"
  if (gb < 24) return "medium"
  if (gb < 64) return "high"
  return "extreme"
}

// ── Fallback Profiles ────────────────────────────────────

export function estimateProfile(): CapacityProfile {
  const machine = collectStaticInventory()
  const scores: CapacityScores = {
    cpuSingle: machine.perfCores ? machine.perfCores * 100 : machine.cpuCount * 50,
    cpuMulti: machine.cpuCount * 40,
    memoryHeadroom: machine.freeMemoryBytes,
    diskWriteMbSec: 500,
    diskReadMbSec: 1000,
    repoScanFilesPerSec: 5000,
  }

  const scheduler = deriveSchedulerLimits(machine, scores)

  return {
    version: 1,
    generatedAt: Date.now(),
    machine,
    scores,
    scheduler,
    confidence: "estimated",
  }
}

// ── Limit Derivation ─────────────────────────────────────

export function deriveSchedulerLimits(machine: MachineInfo, _scores: CapacityScores): SchedulerLimits {
  let maxAgents: number
  let cpuHeavy: number
  let ioHeavy: number
  let searchMedium: number
  let readLight: number
  let network: number

  switch (machine.memoryClass) {
    case "low":
      maxAgents = 4
      cpuHeavy = 1
      ioHeavy = 1
      searchMedium = 2
      readLight = 12
      network = 4
      break
    case "medium":
      maxAgents = 8
      cpuHeavy = 2
      ioHeavy = 1
      searchMedium = 4
      readLight = 24
      network = 8
      break
    case "high":
      maxAgents = 18
      cpuHeavy = 4
      ioHeavy = 2
      searchMedium = 8
      readLight = 48
      network = 12
      break
    case "extreme":
      maxAgents = 32
      cpuHeavy = 8
      ioHeavy = 3
      searchMedium = 12
      readLight = 64
      network = 16
      break
  }

  return {
    maxAgents,
    maxActiveSubprocesses: maxAgents,
    resourceLimits: {
      cpu_heavy: cpuHeavy,
      io_heavy: ioHeavy,
      search_medium: searchMedium,
      read_light: readLight,
      network,
      exclusive_repo: 1,
    },
    queueBackpressure: {
      cpu_heavy: { warnThreshold: cpuHeavy * 2, rejectThreshold: cpuHeavy * 4, timeoutMultiplier: 2 },
      io_heavy: { warnThreshold: 2, rejectThreshold: 4, timeoutMultiplier: 3 },
      search_medium: { warnThreshold: searchMedium * 3, rejectThreshold: searchMedium * 6, timeoutMultiplier: 1.5 },
      read_light: { warnThreshold: 64, rejectThreshold: 128, timeoutMultiplier: 1 },
      network: { warnThreshold: network * 2, rejectThreshold: network * 4, timeoutMultiplier: 1.5 },
      exclusive_repo: { warnThreshold: 2, rejectThreshold: 4, timeoutMultiplier: 5 },
    },
  }
}

// ── Profile Storage ──────────────────────────────────────
// In production, stored under userData/state/capacity-profile.json
// For now, return the profile object; caller handles persistence.
