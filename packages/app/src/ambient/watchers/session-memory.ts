import type { WatcherStatus } from "@/context/ambient"

interface SessionMemoryCheck {
  lastTopic: string | null
  lastStatus: string | null
  activeTask: string | null
}

let lastMemory: SessionMemoryCheck | null = null
let previousTopic: string | null = null

async function getSessionMemory(): Promise<SessionMemoryCheck | null> {
  // In a real implementation, this would read from the session store
  // or from the opencode CLI's session memory
  const api = (window as unknown as { api?: Record<string, unknown> }).api
  if (api?.getSessionMemory && typeof api.getSessionMemory === "function") {
    try {
      const result = await (api.getSessionMemory as () => Promise<SessionMemoryCheck>)()
      return result
    } catch {
      return null
    }
  }

  try {
    const res = await fetch("/api/session/memory", { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const data = (await res.json()) as SessionMemoryCheck
      return data
    }
  } catch {
    // No session memory backend available
  }

  return null
}

export async function checkSessionMemory(): Promise<WatcherStatus | null> {
  const memory = await getSessionMemory()
  if (!memory && !lastMemory) return null

  const effective = memory ?? lastMemory
  if (!effective) return null

  lastMemory = effective

  // If we have an active task, surface it
  if (effective.activeTask && effective.activeTask !== previousTopic) {
    previousTopic = effective.activeTask
    return {
      id: "memory",
      label: "Session",
      description: `Continuing: ${effective.activeTask}`,
      icon: "history",
      status: "info",
      severity: 1,
      timestamp: Date.now(),
      dismissible: true,
      action: { label: "Resume", run: () => {} },
    }
  }

  if (effective.lastTopic && effective.lastTopic !== previousTopic) {
    previousTopic = effective.lastTopic
    return {
      id: "memory",
      label: "Session",
      description: `Previously working on: ${effective.lastTopic}`,
      icon: "history",
      status: "info",
      severity: 0,
      timestamp: Date.now(),
      dismissible: true,
      action: { label: "Continue", run: () => {} },
    }
  }

  return null
}
