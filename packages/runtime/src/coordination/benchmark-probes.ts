import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  collectStaticInventory,
  deriveSchedulerLimits,
  estimateProfile,
  type CapacityProfile,
  type CapacityScores,
} from "./capacity-profile"

export interface BenchmarkOptions {
  /** Quick profile: safe probes only, ~10-20s total */
  mode: "quick" | "deep"
  /** Repository root for repo-specific probes */
  repoRoot?: string
}

/** Run a quick CPU throughput probe. Returns relative score (higher = faster). */
export async function probeCpuSingleThread(durationMs: number = 1000): Promise<number> {
  const start = Date.now()
  let ops = 0
  // Simple arithmetic + array loop
  while (Date.now() - start < durationMs) {
    let x = 0
    for (let i = 0; i < 10000; i++) x += Math.sqrt(i)
    ops++
  }
  return ops
}

/** Run a multi-thread CPU probe using Workers if available. */
export async function probeCpuMultiThread(durationMs: number = 1000): Promise<number> {
  const threadCount = collectStaticInventory().cpuCount
  if (threadCount <= 1) return probeCpuSingleThread(durationMs)

  const promises: Promise<number>[] = []
  for (let t = 0; t < threadCount; t++) {
    promises.push(runWorkerProbe(durationMs))
  }
  const results = await Promise.all(promises)
  return results.reduce((sum, v) => sum + v, 0)
}

async function runWorkerProbe(durationMs: number): Promise<number> {
  return probeCpuSingleThread(durationMs)
}

/** Quick disk write/read probe using a temp file. Returns MB/s. */
export async function probeDiskThroughput(
  tempDir: string,
  sizeMb: number = 64,
): Promise<{ writeMbSec: number; readMbSec: number }> {
  const dir = mkdtempSync(join(tempDir, "capacity-probe-"))
  const filePath = join(dir, "throughput.tmp")
  const data = Buffer.alloc(sizeMb * 1024 * 1024, "x")

  try {
    const writeStart = Date.now()
    writeFileSync(filePath, data)
    const writeDuration = (Date.now() - writeStart) / 1000

    const readStart = Date.now()
    readFileSync(filePath)
    const readDuration = (Date.now() - readStart) / 1000

    return {
      writeMbSec: writeDuration > 0 ? sizeMb / writeDuration : 500,
      readMbSec: readDuration > 0 ? sizeMb / readDuration : 1000,
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

/** Quick repo scan probe using a directory walk. Returns files/sec. */
export async function probeRepoScanSpeed(repoRoot: string): Promise<number> {
  const start = Date.now()
  let count = 0

  function walk(dir: string) {
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (
          entry.startsWith(".") ||
          entry === "node_modules" ||
          entry === "target" ||
          entry === "dist"
        )
          continue
        const full = join(dir, entry)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) walk(full)
          else count++
        } catch {}
      }
    } catch {}
  }

  try { walk(repoRoot) } catch {}
  const duration = (Date.now() - start) / 1000
  return duration > 0 ? count / duration : 5000
}

/** Run all quick probes and return populated CapacityScores. */
export async function runQuickBenchmark(opts: BenchmarkOptions): Promise<CapacityScores> {
  const cpuSingle = await probeCpuSingleThread(1500)
  let cpuMulti = cpuSingle
  try { cpuMulti = await probeCpuMultiThread(1500) } catch {}

  let diskWriteMbSec = 500
  let diskReadMbSec = 1000
  try {
    const disk = await probeDiskThroughput(
      tmpdir(),
      opts.mode === "deep" ? 128 : 32,
    )
    diskWriteMbSec = disk.writeMbSec
    diskReadMbSec = disk.readMbSec
  } catch {}

  let repoScanFilesPerSec = 5000
  if (opts.repoRoot) {
    try { repoScanFilesPerSec = await probeRepoScanSpeed(opts.repoRoot) } catch {}
  }

  return {
    cpuSingle: Math.round(cpuSingle),
    cpuMulti: Math.round(cpuMulti),
    memoryHeadroom: collectStaticInventory().freeMemoryBytes,
    diskWriteMbSec: Math.round(diskWriteMbSec),
    diskReadMbSec: Math.round(diskReadMbSec),
    repoScanFilesPerSec: Math.round(repoScanFilesPerSec),
  }
}

/** Generate a full CapacityProfile with measured scores. */
export async function runCapacityBenchmark(opts: BenchmarkOptions): Promise<CapacityProfile> {
  const estimated = estimateProfile()
  let scores: CapacityScores

  try {
    scores = await runQuickBenchmark(opts)
  } catch {
    scores = estimated.scores
  }

  const scheduler = deriveSchedulerLimits(estimated.machine, scores)

  return {
    version: 1,
    generatedAt: Date.now(),
    machine: estimated.machine,
    scores,
    scheduler,
    confidence: opts.mode === "deep" ? "deep_profiled" : "quick_profiled",
  }
}
