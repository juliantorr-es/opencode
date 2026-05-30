import type { WatcherStatus } from "@/context/ambient"

interface GitCheck {
  uncommitted: number
  unpushed: number
  mergeConflicts: number
  branch: string | null
}

async function getGitStatus(): Promise<GitCheck | null> {
  // In the desktop app, try window.api first
  const api = (window as unknown as { api?: Record<string, unknown> }).api
  if (api?.getGitStatus && typeof api.getGitStatus === "function") {
    try {
      const result = await (api.getGitStatus as () => Promise<GitCheck>)()
      return result
    } catch {
      return null
    }
  }

  // Fallback: check if we can fetch from a local server endpoint
  try {
    const res = await fetch("/api/git/status", { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const data = (await res.json()) as GitCheck
      return data
    }
  } catch {
    // No git backend available
  }

  return null
}

export async function checkGitStatus(): Promise<WatcherStatus | null> {
  const git = await getGitStatus()
  if (!git) return null

  const { uncommitted, unpushed, mergeConflicts, branch } = git
  const branchName = branch ?? "unknown"

  if (mergeConflicts > 0) {
    return {
      id: "git",
      label: "Git",
      description: `${mergeConflicts} merge conflict${mergeConflicts > 1 ? "s" : ""} on ${branchName}`,
      icon: "warning",
      status: "alert",
      severity: 3,
      timestamp: Date.now(),
      dismissible: true,
      action: { label: "View conflicts", run: () => {} },
    }
  }

  if (unpushed > 0 && uncommitted > 0) {
    return {
      id: "git",
      label: "Git",
      description: `${uncommitted} uncommitted, ${unpushed} unpushed on ${branchName}`,
      icon: "git",
      status: "warning",
      severity: 2,
      timestamp: Date.now(),
      dismissible: true,
    }
  }

  if (unpushed > 0) {
    return {
      id: "git",
      label: "Git",
      description: `${unpushed} commit${unpushed > 1 ? "s" : ""} to push on ${branchName}`,
      icon: "git",
      status: "info",
      severity: 1,
      timestamp: Date.now(),
      dismissible: true,
      action: { label: "Push", run: () => {} },
    }
  }

  if (uncommitted > 0) {
    return {
      id: "git",
      label: "Git",
      description: `${uncommitted} uncommitted change${uncommitted > 1 ? "s" : ""} on ${branchName}`,
      icon: "git",
      status: "info",
      severity: 1,
      timestamp: Date.now(),
      dismissible: true,
    }
  }

  return {
    id: "git",
    label: "Git",
    description: `Clean working tree on ${branchName}`,
    icon: "git",
    status: "ok",
    severity: 0,
    timestamp: Date.now(),
    dismissible: false,
  }
}
