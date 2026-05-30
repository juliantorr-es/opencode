import type { WatcherStatus } from "@/context/ambient"

interface PRCheck {
  needsReview: number
  failingCI: number
  prs: Array<{ number: number; title: string; status: string }>
}

async function getPRStatus(): Promise<PRCheck | null> {
  const api = (window as unknown as { api?: Record<string, unknown> }).api
  if (api?.getPullRequestStatus && typeof api.getPullRequestStatus === "function") {
    try {
      const result = await (api.getPullRequestStatus as () => Promise<PRCheck>)()
      return result
    } catch {
      return null
    }
  }

  try {
    const res = await fetch("/api/pr/status", { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const data = (await res.json()) as PRCheck
      return data
    }
  } catch {
    // No PR backend available
  }

  return null
}

export async function checkPRActivity(): Promise<WatcherStatus | null> {
  const pr = await getPRStatus()
  if (!pr) return null

  const { needsReview, failingCI, prs } = pr

  if (failingCI > 0) {
    const prNames = prs
      .filter((p) => p.status === "ci_failing")
      .map((p) => `#${p.number}`)
      .slice(0, 3)
    const suffix = prNames.length > 0 ? `: ${prNames.join(", ")}${prs.length > 3 ? "..." : ""}` : ""
    return {
      id: "pr",
      label: "Pull Requests",
      description: `${failingCI} PR${failingCI > 1 ? "s" : ""} with failing CI${suffix}`,
      icon: "warning",
      status: "alert",
      severity: 3,
      timestamp: Date.now(),
      dismissible: true,
      action: { label: "View CI", run: () => {} },
    }
  }

  if (needsReview > 0) {
    const prNames = prs
      .filter((p) => p.status === "needs_review")
      .map((p) => `#${p.number}`)
      .slice(0, 3)
    const suffix = prNames.length > 0 ? `: ${prNames.join(", ")}${prs.length > 3 ? "..." : ""}` : ""
    return {
      id: "pr",
      label: "Pull Requests",
      description: `${needsReview} open PR${needsReview > 1 ? "s" : ""} needing review${suffix}`,
      icon: "git-pull-request",
      status: "info",
      severity: 1,
      timestamp: Date.now(),
      dismissible: true,
      action: { label: "Review", run: () => {} },
    }
  }

  return null
}
