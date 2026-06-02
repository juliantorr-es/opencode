// ── Coordination Fabric ─────────────────────────────────
// Optional coordination plane for live agent coordination.
// Local mode works without Valkey/Redis. Durable truth stays in DB.

export interface AgentHeartbeat {
  agentId: string
  repoId: string
  status: string
  timestamp: number
}

export interface LeaseRequest {
  repoId: string
  path: string
  agentId: string
  ttlMs: number
}

export interface LeaseResult {
  granted: boolean
  leaseId?: string
  conflictAgentId?: string
}

export interface CoordinationEvent {
  type: string
  payload: Record<string, unknown>
  timestamp: number
}

export interface CoordinationJob {
  id: string
  type: string
  payload: Record<string, unknown>
}

export interface BackpressureState {
  queued: number
  processing: number
  throttled: boolean
}

export interface CoordinationFabric {
  heartbeat(agent: AgentHeartbeat): Promise<void>
  acquireLease(input: LeaseRequest): Promise<LeaseResult>
  releaseLease(leaseId: string): Promise<void>
  publish(event: CoordinationEvent): Promise<void>
  subscribe(topic: string, handler: (event: CoordinationEvent) => void): Promise<() => void>
  enqueue(queue: string, job: CoordinationJob): Promise<void>
  dequeue(queue: string): Promise<CoordinationJob | undefined>
  backpressure(queue: string): Promise<BackpressureState>
  dispose(): Promise<void>
}

// ── Fabric Factory ──────────────────────────────────────
// Returns the appropriate CoordinationFabric based on env.

export async function createFabric(): Promise<CoordinationFabric> {
  const backend = process.env.OPENCODE_COORDINATION_BACKEND ?? "local"
  if (backend === "local") {
    const { createLocalFabric } = await import("./local-fabric")
    return createLocalFabric()
  }
  if (backend === "local-valkey" || backend === "remote-valkey") {
    const url = process.env.OPENCODE_VALKEY_URL ?? "redis://127.0.0.1:6379"
    const { createValkeyFabric } = await import("./valkey-fabric")
    try {
      return await createValkeyFabric(url)
    } catch (e) {
      console.error(`[coordination] Valkey fabric failed — falling back to local: ${(e as Error).message}`)
      const { createLocalFabric } = await import("./local-fabric")
      return createLocalFabric()
    }
  }
  // default: local
  const { createLocalFabric } = await import("./local-fabric")
  return createLocalFabric()
}
