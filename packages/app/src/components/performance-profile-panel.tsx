import { createSignal, createEffect, onCleanup } from "solid-js"

/**
 * Performance Profile Panel — shows machine capacity, scheduler limits,
 * and current system pressure.
 */

export interface ProfileUIData {
  mode: "conservative" | "balanced" | "aggressive" | "custom"
  machine: {
    platform: string
    arch: string
    cpuCount: number
    memoryClass: string
    totalMemoryGb: number
  }
  limits: {
    maxAgents: number
    cpuHeavy: number
    ioHeavy: number
    searchMedium: number
    readLight: number
    network: number
  }
  pressure: {
    level: string
    eventLoopLagMs: number
    memoryPressure: number
    queueDepth: number
  } | null
  confidence: string
}

export function PerformanceProfilePanel(props: { data?: ProfileUIData }) {
  const [mode, setMode] = createSignal(props.data?.mode ?? "balanced")

  const data = () => props.data

  function modeColor(m: string) {
    switch (m) {
      case "conservative": return "text-green-400"
      case "balanced": return "text-blue-400"
      case "aggressive": return "text-yellow-400"
      case "custom": return "text-purple-400"
      default: return "text-text-weak"
    }
  }

  function pressureColor(level: string) {
    switch (level) {
      case "critical": return "bg-red-500"
      case "high": return "bg-orange-500"
      case "elevated": return "bg-yellow-500"
      case "normal": return "bg-blue-500"
      default: return "bg-green-500"
    }
  }

  return (
    <div class="flex flex-col h-full bg-surface-base">
      <div class="px-3 py-2 border-b border-surface-border">
        <span class="text-13-regular font-medium">Performance Profile</span>
      </div>

      <div class="flex-1 overflow-auto p-3 space-y-3">
        {/* Mode selector */}
        <div>
          <label class="text-11-regular text-text-weak uppercase tracking-wider">Mode</label>
          <div class="flex gap-1 mt-1">
            {["conservative", "balanced", "aggressive"].map(m => (
              <button
                class={`px-2 py-0.5 text-11-regular rounded ${mode() === m ? "bg-accent text-accent-contrast" : "bg-surface-raised text-text-weak"}`}
                onClick={() => setMode(m as any)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Machine info */}
        {data() && (
          <>
            <div>
              <span class="text-10-regular text-text-weak uppercase tracking-wider">Machine</span>
              <div class="mt-1 text-11-regular space-y-0.5">
                <div>{data()!.machine.platform} / {data()!.machine.arch}</div>
                <div>{data()!.machine.cpuCount} cores · {data()!.machine.totalMemoryGb.toFixed(0)} GB · {data()!.machine.memoryClass}</div>
              </div>
            </div>

            {/* Limits */}
            <div>
              <span class="text-10-regular text-text-weak uppercase tracking-wider">Limits</span>
              <div class="mt-1 grid grid-cols-3 gap-1 text-11-regular">
                {Object.entries(data()!.limits).map(([key, val]) => (
                  <div class="bg-surface-raised px-1.5 py-0.5 rounded">
                    <span class="text-text-weak">{key}</span>
                    <span class="float-right font-medium">{val}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Pressure */}
            {data()!.pressure && (
              <div>
                <span class="text-10-regular text-text-weak uppercase tracking-wider">
                  Pressure
                  <span class={`ml-1 inline-block w-2 h-2 rounded-full ${pressureColor(data()!.pressure!.level)}`} />
                </span>
                <div class="mt-1 text-11-regular space-y-0.5">
                  <div>Level: <span class="font-medium">{data()!.pressure!.level}</span></div>
                  <div>Event loop lag: {data()!.pressure!.eventLoopLagMs.toFixed(1)}ms</div>
                  <div>Memory: {(data()!.pressure!.memoryPressure * 100).toFixed(0)}%</div>
                  <div>Queue depth: {data()!.pressure!.queueDepth}</div>
                </div>
              </div>
            )}

            {/* Confidence */}
            <div class="text-10-regular text-text-weak">
              Confidence: {data()!.confidence}
            </div>
          </>
        )}

        {!data() && (
          <div class="text-11-regular text-text-weak">
            Run a benchmark to see your machine profile.
          </div>
        )}
      </div>
    </div>
  )
}
