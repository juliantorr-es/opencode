import type { WatcherStatus } from "@/context/ambient"

interface TestCheck {
  failing: number
  passing: number
  total: number
  targetFile: string | null
}

async function getTestStatus(): Promise<TestCheck | null> {
  const api = (window as unknown as { api?: Record<string, unknown> }).api
  if (api?.getTestStatus && typeof api.getTestStatus === "function") {
    try {
      const result = await (api.getTestStatus as () => Promise<TestCheck>)()
      return result
    } catch {
      return null
    }
  }

  try {
    const res = await fetch("/api/tests/status", { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const data = (await res.json()) as TestCheck
      return data
    }
  } catch {
    // No test backend available
  }

  return null
}

export async function checkTestStatus(): Promise<WatcherStatus | null> {
  const test = await getTestStatus()
  if (!test) return null

  if (test.failing > 0) {
    const target = test.targetFile ? ` in ${test.targetFile}` : ""
    return {
      id: "test",
      label: "Tests",
      description: `${test.failing} test${test.failing > 1 ? "s" : ""} failing${target}`,
      icon: "warning",
      status: "alert",
      severity: 3,
      timestamp: Date.now(),
      dismissible: true,
      action: { label: "Run tests", run: () => {} },
    }
  }

  if (test.total > 0) {
    return {
      id: "test",
      label: "Tests",
      description: `${test.passing}/${test.total} tests passing`,
      icon: "check",
      status: "ok",
      severity: 0,
      timestamp: Date.now(),
      dismissible: false,
    }
  }

  return null
}
