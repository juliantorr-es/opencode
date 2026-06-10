import Redis from "ioredis"
import type { CoordinationFabric, AgentHeartbeat, LeaseRequest, LeaseResult, CoordinationEvent, CoordinationJob, BackpressureState } from "./fabric"
import { ValkeyStreams } from "./stream-primitives"

export async function createValkeyFabric(url: string): Promise<CoordinationFabric> {
  const redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 })

  await redis.ping()

  const subscribers = new Map<string, Set<(event: CoordinationEvent) => void>>()
  const generationKey = "coord:generation"
  const streams = new ValkeyStreams(redis)

  async function generation(): Promise<number> {
    const raw = await redis.get(generationKey)
    if (raw !== null) return Number.parseInt(raw, 10)
    await redis.set(generationKey, "1")
    return 1
  }

  async function reset(): Promise<number> {
    const next = (await generation()) + 1
    const cleanup = [
      ...(await redis.keys("agent:*:heartbeat")),
      ...(await redis.keys("repo:*:lease:*")),
      ...(await redis.keys("repo:*:agents")),
      ...(await redis.keys("queue:*")),
    ]
    if (cleanup.length > 0) await redis.del(...cleanup)
    await redis.set(generationKey, String(next))
    subscribers.clear()
    return next
  }

  return {
    async heartbeat(agent: AgentHeartbeat): Promise<void> {
      const key = `agent:${agent.agentId}:heartbeat`
      await redis.set(key, JSON.stringify(agent), "EX", 30)
      await redis.sadd(`repo:${agent.repoId}:agents`, agent.agentId)
    },

    async acquireLease(input: LeaseRequest): Promise<LeaseResult> {
      const key = `repo:${input.repoId}:lease:${input.path}`
      const value = JSON.stringify({ agentId: input.agentId, acquiredAt: Date.now() })
      // @ts-expect-error ioredis overloading for NX/EX
      const result = await redis.set(key, value, "NX", "EX", Math.ceil(input.ttlMs / 1000))
      if (result === "OK") return { granted: true, leaseId: key }
      const existing = await redis.get(key)
      if (existing) {
        const parsed = JSON.parse(existing) as { agentId: string }
        return { granted: false, conflictAgentId: parsed.agentId }
      }
      return { granted: false }
    },

    async releaseLease(leaseId: string): Promise<void> {
      await redis.del(leaseId)
    },

    async publish(event: CoordinationEvent): Promise<void> {
      await redis.publish("tribunus:events", JSON.stringify(event))
    },

    async subscribe(topic: string, handler: (event: CoordinationEvent) => void): Promise<() => void> {
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

    async enqueue(queue: string, job: CoordinationJob): Promise<void> {
      // For now, maintain backward compatibility with LPUSH/RPUSH
      // TODO: Migrate to stream-backed queue
      await redis.lpush(`queue:${queue}`, JSON.stringify(job))
    },

    async dequeue(queue: string): Promise<CoordinationJob | undefined> {
      // For now, maintain backward compatibility with LPUSH/RPUSH
      // TODO: Migrate to stream-backed queue
      const raw = await redis.rpop(`queue:${queue}`)
      if (!raw) return undefined
      return JSON.parse(raw) as CoordinationJob
    },

    async backpressure(queue: string): Promise<BackpressureState> {
      // For now, maintain backward compatibility with LPUSH/RPUSH
      // TODO: Migrate to stream-backed queue
      const len = await redis.llen(`queue:${queue}`)
      return { queued: len, processing: 0, throttled: len > 100 }
    },

    generation,

    reset,

    async snapshot(): Promise<{ generation: number; heartbeats: number; leases: number; queues: number }> {
      const current = await generation()
      const heartbeats = await redis.keys("agent:*:heartbeat")
      const leases = await redis.keys("repo:*:lease:*")
      const queues = await redis.keys("queue:*")
      return {
        generation: current,
        heartbeats: heartbeats.length,
        leases: leases.length,
        queues: queues.length,
      }
    },

    streams,

    async dispose(): Promise<void> {
      subscribers.clear()
      await redis.quit()
    },
  }
}
