import Redis from "ioredis"
import type { CoordinationFabric, AgentHeartbeat, LeaseRequest, LeaseResult, CoordinationEvent, CoordinationJob, BackpressureState } from "./fabric"

export async function createValkeyFabric(url: string): Promise<CoordinationFabric> {
  const redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 })

  await redis.ping()

  const subscribers = new Map<string, Set<(event: CoordinationEvent) => void>>()

  return {
    async heartbeat(agent) {
      const key = `agent:${agent.agentId}:heartbeat`
      await redis.set(key, JSON.stringify(agent), "EX", 30)
      await redis.sadd(`repo:${agent.repoId}:agents`, agent.agentId)
    },

    async acquireLease(input) {
      const key = `repo:${input.repoId}:lease:${input.path}`
      const value = JSON.stringify({ agentId: input.agentId, acquiredAt: Date.now() })
      const result = await redis.set(key, value, "NX", "EX", Math.ceil(input.ttlMs / 1000))
      if (result === "OK") return { granted: true, leaseId: key }
      const existing = await redis.get(key)
      if (existing) {
        const parsed = JSON.parse(existing) as { agentId: string }
        return { granted: false, conflictAgentId: parsed.agentId }
      }
      return { granted: false }
    },

    async releaseLease(leaseId) {
      await redis.del(leaseId)
    },

    async publish(event) {
      await redis.publish("tribunus:events", JSON.stringify(event))
    },

    async subscribe(topic, handler) {
      const sub = redis.duplicate()
      await sub.subscribe("tribunus:events")
      const listener = (_channel: string, message: string) => {
        try {
          const event = JSON.parse(message) as CoordinationEvent
          if (event.type.startsWith(topic)) handler(event)
        } catch {}
      }
      sub.on("message", listener)
      if (!subscribers.has(topic)) subscribers.set(topic, new Set())
      subscribers.get(topic)!.add(handler)
      return async () => {
        sub.off("message", listener)
        await sub.quit()
        subscribers.get(topic)?.delete(handler)
      }
    },

    async enqueue(queue, job) {
      await redis.lpush(`queue:${queue}`, JSON.stringify(job))
    },

    async dequeue(queue) {
      const raw = await redis.rpop(`queue:${queue}`)
      if (!raw) return undefined
      return JSON.parse(raw) as CoordinationJob
    },

    async backpressure(queue) {
      const len = await redis.llen(`queue:${queue}`)
      return { queued: len, processing: 0, throttled: len > 100 }
    },

    async dispose() {
      subscribers.clear()
      await redis.quit()
    },
  }
}
