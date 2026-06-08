import type { Redis } from "ioredis"

export const DEFAULT_HEARTBEAT_TTL = 30
export const DEFAULT_LEASE_TTL = 60

const HEARTBEAT_PREFIX = "agent:heartbeat:"
const LEASE_PREFIX = "lease:"
const UI_PREFIX = "ui:"

const RENEW_LEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("EXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`

const RELEASE_LEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`

export class HeartbeatLeaseManager {
  constructor(private readonly redis: Redis) {}

  // ── Heartbeats ────────────────────────────────────────────────────────

  async heartbeat(agentId: string): Promise<void> {
    await this.redis.set(
      `${HEARTBEAT_PREFIX}${agentId}`,
      "",
      "EX",
      DEFAULT_HEARTBEAT_TTL,
    )
  }

  async isAgentAlive(agentId: string): Promise<boolean> {
    const result = await this.redis.exists(`${HEARTBEAT_PREFIX}${agentId}`)
    return result === 1
  }

  async getActiveAgents(): Promise<string[]> {
    const pattern = `${HEARTBEAT_PREFIX}*`
    const keys: string[] = []
    let cursor = "0"

    do {
      const [nextCursor, batch] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      )
      cursor = nextCursor
      for (const key of batch) {
        keys.push(key)
      }
    } while (cursor !== "0")

    if (keys.length === 0) return []

    // Filter to only keys that still exist (TTL may have expired between SCAN and now)
    const multi = this.redis.multi()
    for (const _key of keys) {
      multi.exists(_key)
    }
    const results = (await multi.exec()) ?? []

    return keys.filter((key, i) => {
      const raw = results[i]?.[1]
      return typeof raw === "number" && raw === 1
    }).map((key) => key.slice(HEARTBEAT_PREFIX.length))
  }

  async getAgentHeartbeatAge(agentId: string): Promise<number | null> {
    const ms = await this.redis.pttl(`${HEARTBEAT_PREFIX}${agentId}`)
    // ioredis returns -2 for missing key, -1 for no expiry, positive for ms remaining
    if (ms < 0) return null
    return ms
  }

  // ── Leases ────────────────────────────────────────────────────────────

  async acquireLease(
    taskId: string,
    agentId: string,
    ttlSeconds: number = DEFAULT_LEASE_TTL,
  ): Promise<boolean> {
    const key = `${LEASE_PREFIX}${taskId}`
    const result = await this.redis.set(key, agentId, "EX", ttlSeconds, "NX")
    return result === "OK"
  }

  async renewLease(
    taskId: string,
    agentId: string,
    ttlSeconds: number = DEFAULT_LEASE_TTL,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      RENEW_LEASE_SCRIPT,
      1,
      `${LEASE_PREFIX}${taskId}`,
      agentId,
      ttlSeconds,
    )
    return result === 1
  }

  async releaseLease(
    taskId: string,
    agentId: string,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      RELEASE_LEASE_SCRIPT,
      1,
      `${LEASE_PREFIX}${taskId}`,
      agentId,
    )
    return result === 1
  }

  async getLeaseHolder(taskId: string): Promise<string | null> {
    const value = await this.redis.get(`${LEASE_PREFIX}${taskId}`)
    return value
  }

  async getLeaseTTL(taskId: string): Promise<number | null> {
    const ms = await this.redis.pttl(`${LEASE_PREFIX}${taskId}`)
    if (ms < 0) return null
    return ms
  }

  // ── Pub/Sub (volatile UI signals only) ────────────────────────────────

  async publishUISignal(channel: string, message: unknown): Promise<void> {
    const json = JSON.stringify(message)
    await this.redis.publish(`${UI_PREFIX}${channel}`, json)
  }

  async subscribeUISignals(
    channel: string,
    handler: (msg: unknown) => void,
  ): Promise<() => void> {
    const sub = this.redis.duplicate()
    const fullChannel = `${UI_PREFIX}${channel}`

    await sub.subscribe(fullChannel)

    const listener = (_channel: string, message: string) => {
      try {
        handler(JSON.parse(message))
      } catch {
        // Ignore malformed messages on volatile UI pub/sub
      }
    }

    sub.on("message", listener)

    return async () => {
      sub.off("message", listener)
      await sub.unsubscribe(fullChannel)
      await sub.quit()
    }
  }
}
