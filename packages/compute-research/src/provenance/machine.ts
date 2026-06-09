import { $ } from "bun"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MachineProvenance {
  anon_id: string
  model_identifier: string
  chip_family: string
  perf_cores: number
  eff_cores: number
  gpu_cores: number
  neural_engine?: string
  physical_memory: string
  storage_type?: string
  disk_available?: string
  os_version: string
  kernel_version: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Namespace salt for generating the pseudonymous machine ID.
 *  Changing this salt changes every machine identity — treat it as
 *  a stable constant for the lifetime of the evidence plane. */
const NAMESPACE_SALT = "com.tribunus.machine-identity.v1"

/** GPU-core count lookup keyed by chip-family prefix. */
const GPU_CORES: Record<string, number> = {
  "M1": 7,
  "M1 Pro": 14,
  "M1 Max": 32,
  "M1 Ultra": 64,
  "M2": 10,
  "M2 Pro": 19,
  "M2 Max": 38,
  "M2 Ultra": 76,
  "M3": 10,
  "M3 Pro": 18,
  "M3 Max": 40,
  "M4": 10,
  "M4 Pro": 20,
  "M4 Max": 40,
}

/** Neural-engine description lookup keyed by chip-family prefix. */
const NEURAL_ENGINE: Record<string, string> = {
  "M1": "Apple Neural Engine (16-core)",
  "M1 Pro": "Apple Neural Engine (16-core)",
  "M1 Max": "Apple Neural Engine (16-core)",
  "M1 Ultra": "Apple Neural Engine (32-core)",
  "M2": "Apple Neural Engine (16-core)",
  "M2 Pro": "Apple Neural Engine (16-core)",
  "M2 Max": "Apple Neural Engine (16-core)",
  "M2 Ultra": "Apple Neural Engine (32-core)",
  "M3": "Apple Neural Engine (16-core)",
  "M3 Pro": "Apple Neural Engine (16-core)",
  "M3 Max": "Apple Neural Engine (16-core)",
  "M4": "Apple Neural Engine (16-core)",
  "M4 Pro": "Apple Neural Engine (16-core)",
  "M4 Max": "Apple Neural Engine (16-core)",
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the Apple chip variant from `machdep.cpu.brand_string`.
 *  Returns e.g. "M3 Max", "M2 Pro", or "" for Intel. */
function resolveChipVariant(brand: string): string {
  // Apple Silicon: "Apple M3 Max" → "M3 Max"
  const appleMatch = brand.match(/^Apple\s+(.+)/)
  if (appleMatch) return appleMatch[1]!

  // Intel / other
  return ""
}

/** Look up GPU core count from a chip variant string. */
function lookupGpuCores(chipVariant: string): number {
  // Try exact match first, then prefix match (e.g. "M3 Max" matches "M3 Max" key)
  const exact = GPU_CORES[chipVariant]
  if (exact !== undefined) return exact

  // Prefix match: "M3 Max (40-core)" → try "M3 Max"
  for (const key of Object.keys(GPU_CORES)) {
    if (chipVariant.startsWith(key)) return GPU_CORES[key]!
  }

  return 0
}

/** Look up neural-engine description from a chip variant string. */
function lookupNeuralEngine(chipVariant: string): string {
  const exact = NEURAL_ENGINE[chipVariant]
  if (exact !== undefined) return exact

  for (const key of Object.keys(NEURAL_ENGINE)) {
    if (chipVariant.startsWith(key)) return NEURAL_ENGINE[key]!
  }

  return ""
}

/** Format raw bytes into a human-readable string, e.g. "64 GB". */
function formatBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024)
  // Round to nearest integer GB
  return `${Math.round(gib)} GB`
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Capture machine provenance from the current host.
 *
 * Generates a stable pseudonymous machine ID by hashing the hardware UUID
 * with a fixed namespace salt — the raw serial/UUID is never returned.
 * All shell commands use Bun.$.
 */
export async function captureMachineProvenance(): Promise<MachineProvenance> {
  // ── anon_id: pseudonymous machine identifier ────────────────────────────
  // Read IOPlatformUUID (NOT IOPlatformSerialNumber) — Apple already
  // provides a per-device UUID that does not encode the serial.
  const ioregOut = await $`ioreg -rd1 -c IOPlatformExpertDevice`.quiet().text()
  const uuidMatch = ioregOut.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
  const hardwareUuid = uuidMatch?.[1] ?? ""

  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(NAMESPACE_SALT)
  hasher.update(hardwareUuid)
  const anonId = hasher.digest("hex")

  // ── Model identifier & chip family ──────────────────────────────────────
  const modelId = await $`sysctl -n hw.model`.quiet().text().then(r => r.trim()).catch(() => "")
  const brandString = await $`sysctl -n machdep.cpu.brand_string`.quiet().text().then(r => r.trim()).catch(() => "")

  const isAppleSilicon = brandString.startsWith("Apple")
  const chipFamily = isAppleSilicon ? "Apple" : "Intel"
  const chipVariant = resolveChipVariant(brandString)

  // ── Core counts ─────────────────────────────────────────────────────────
  const perfCores = await $`sysctl -n hw.perflevel0.logicalcpu`.quiet().text().then(r => parseInt(r.trim(), 10)).catch(() => 0)
  const effCores = await $`sysctl -n hw.perflevel1.logicalcpu`.quiet().text().then(r => parseInt(r.trim(), 10)).catch(() => 0)

  // ── GPU & Neural Engine ─────────────────────────────────────────────────
  const gpuCores = lookupGpuCores(chipVariant)
  const neuralEngine = lookupNeuralEngine(chipVariant) || undefined

  // ── Memory ──────────────────────────────────────────────────────────────
  const memBytes = await $`sysctl -n hw.memsize`.quiet().text().then(r => parseInt(r.trim(), 10)).catch(() => 0)
  const physicalMemory = formatBytes(memBytes)

  // ── OS & Kernel ─────────────────────────────────────────────────────────
  const osVersion = await $`sw_vers -productVersion`.quiet().text().then(r => r.trim()).catch(() => "")
  const kernelVersion = await $`sysctl -n kern.osrelease`.quiet().text().then(r => r.trim()).catch(() => "")

  // ── Disk info (optional) ────────────────────────────────────────────────
  let storageType: string | undefined
  let diskAvailable: string | undefined
  try {
    const diskInfo = await $`diskutil info /`.quiet().text()
    const solidState = diskInfo.match(/Solid State:\s+(Yes|No)/i)
    if (solidState) {
      storageType = solidState[1]!.toLowerCase() === "yes" ? "SSD" : "HDD"
    } else {
      storageType = "SSD" // Apple Silicon Macs all use SSDs
    }
  } catch {
    storageType = undefined
  }
  try {
    const dfOut = await $`df -g /`.quiet().text()
    const lines = dfOut.split("\n")
    if (lines.length >= 2) {
      const parts = lines[1]!.split(/\s+/)
      if (parts.length >= 4) {
        diskAvailable = `${parts[3]} GB`
      }
    }
  } catch {
    diskAvailable = undefined
  }

  return {
    anon_id: anonId,
    model_identifier: modelId,
    chip_family: chipFamily,
    perf_cores: perfCores || 0,
    eff_cores: effCores || 0,
    gpu_cores: gpuCores || 0,
    neural_engine: neuralEngine,
    physical_memory: physicalMemory,
    storage_type: storageType,
    disk_available: diskAvailable,
    os_version: osVersion,
    kernel_version: kernelVersion,
  }
}
