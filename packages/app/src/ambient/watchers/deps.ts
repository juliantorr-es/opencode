import type { WatcherStatus } from "@/context/ambient"

interface DepsCheck {
  outdated: number
  vulnerabilities: number
  packages: string[]
}

async function checkDepsBackend(): Promise<DepsCheck | null> {
  const api = (window as unknown as { api?: Record<string, unknown> }).api
  if (api?.getDependencyStatus && typeof api.getDependencyStatus === "function") {
    try {
      const result = await (api.getDependencyStatus as () => Promise<DepsCheck>)()
      return result
    } catch {
      return null
    }
  }

  try {
    const res = await fetch("/api/deps/status", { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const data = (await res.json()) as DepsCheck
      return data
    }
  } catch {
    // No deps backend available
  }

  return null
}

export async function checkDeps(): Promise<WatcherStatus | null> {
  const deps = await checkDepsBackend()
  if (!deps) return null

  const { outdated, vulnerabilities, packages } = deps

  if (vulnerabilities > 0) {
    const names = packages.length > 0 ? `: ${packages.slice(0, 3).join(", ")}${packages.length > 3 ? "..." : ""}` : ""
    return {
      id: "deps",
      label: "Dependencies",
      description: `${vulnerabilities} known vulnerabilit${vulnerabilities > 1 ? "ies" : "y"}${names}`,
      icon: "warning",
      status: "alert",
      severity: 3,
      timestamp: Date.now(),
      dismissible: true,
      action: { label: "Audit deps", run: () => {} },
    }
  }

  if (outdated > 0) {
    const names = packages.length > 0 ? `: ${packages.slice(0, 3).join(", ")}${packages.length > 3 ? "..." : ""}` : ""
    return {
      id: "deps",
      label: "Dependencies",
      description: `${outdated} outdated package${outdated > 1 ? "s" : ""}${names}`,
      icon: "package",
      status: "warning",
      severity: 2,
      timestamp: Date.now(),
      dismissible: true,
      action: { label: "Update all", run: () => {} },
    }
  }

  return {
    id: "deps",
    label: "Dependencies",
    description: packages.length > 0 ? `${packages.length} packages up to date` : "All dependencies up to date",
    icon: "check",
    status: "ok",
    severity: 0,
    timestamp: Date.now(),
    dismissible: false,
  }
}
