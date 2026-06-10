import type { CoordinationFabric, AgentHeartbeat, LeaseRequest, LeaseResult, CoordinationEvent, CoordinationJob, BackpressureState } from "./fabric"
import type { ValkeyStreams } from "./stream-primitives"

export function createLocalFabric(): CoordinationFabric {
  const heartbeats = new Map<string, AgentHeartbeat>()
  const leases = new Map<string, { leaseId: string; path: string; agentId: string; expiresAt: number }>()
  const subscribers = new Map<string, Set<(event: CoordinationEvent) => void>>()
  const queues = new Map<string, CoordinationJob[]>()
  let generation = 1

  return {
    async heartbeat(agent) {
      heartbeats.set(agent.agentId, agent)
    },
    async acquireLease(input) {
      const existing = [...leases.values()].find(l => l.path === input.path && l.expiresAt > Date.now())
      if (existing) return { granted: false, conflictAgentId: existing.agentId }
      const leaseId = `lease:${input.repoId}:${input.path}:${Date.now()}`
      leases.set(leaseId, { leaseId, path: input.path, agentId: input.agentId, expiresAt: Date.now() + input.ttlMs })
      return { granted: true, leaseId }
    },
    async releaseLease(leaseId) {
      leases.delete(leaseId)
    },
    async publish(event) {
      for (const [topic, handlers] of subscribers) {
        if (event.type.startsWith(topic)) for (const h of handlers) h(event)
      }
    },
    async subscribe(topic, handler) {
      if (!subscribers.has(topic)) subscribers.set(topic, new Set())
      subscribers.get(topic)!.add(handler)
      return async () => { subscribers.get(topic)?.delete(handler) }
    },
    async enqueue(queue, job) {
      if (!queues.has(queue)) queues.set(queue, [])
      queues.get(queue)!.push(job)
    },
    async dequeue(queue) {
      return queues.get(queue)?.shift()
    },
    async backpressure(queue) {
      const q = queues.get(queue) ?? []
      return { queued: q.length, processing: 0, throttled: q.length > 100 }
    },
    async generation() {
      return generation
    },
    async reset() {
      heartbeats.clear()
      leases.clear()
      queues.clear()
      subscribers.clear()
      generation += 1
      return generation
    },
    async snapshot() {
      return {
        generation,
        heartbeats: heartbeats.size,
        leases: leases.size,
        queues: [...queues.values()].reduce((count, queue) => count + queue.length, 0),
      }
    },
    async dispose() {
      heartbeats.clear()
      leases.clear()
      subscribers.clear()
      queues.clear()
    },
    streams: new Proxy({} as ValkeyStreams, {
      get(_target, prop) {
        throw new Error(
          `LocalFabric has no Valkey streams. ` +
          `Accessing .streams.${String(prop)} requires a stream-capable fabric. ` +
          `Use StreamingCoordinationFabric or provide a real Valkey backend.`
        )
      },
    }),
  }
}
