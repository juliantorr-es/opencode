import type { ToolScheduler, ToolJob, ToolJobResult, ToolJobState, BackpressureState, ResourceClass } from "./tool-scheduler"
import { RESOURCE_CLASS_CONCURRENCY } from "./tool-scheduler"
import type { CoordinationFabric } from "./fabric"
import type { Redis } from "ioredis"

export async function createValkeyToolScheduler(fabric: CoordinationFabric, redisFactory: () => Promise<Redis>): Promise<ToolScheduler> {
  const redis = await redisFactory()

  function semaphoreKey(projectId: string, rc: ResourceClass): string {
    return `tool:semaphore:${projectId}:${rc}`
  }

  function jobKey(jobId: string): string {
    return `tool:job:${jobId}`
  }

  function queueKey(projectId: string, rc: ResourceClass): string {
    return `tool:queue:${projectId}:${rc}`
  }

  let nextId = 1
  function genId(): string {
    return `job_${Date.now()}_${nextId++}_${Math.random().toString(36).slice(2, 8)}`
  }

  async function storeJob(state: ToolJobState): Promise<void> {
    await redis.set(jobKey(state.job.id), JSON.stringify(state), "EX", 3600)
  }

  async function loadJob(jobId: string): Promise<ToolJobState | undefined> {
    const raw = await redis.get(jobKey(jobId))
    if (!raw) return undefined
    return JSON.parse(raw) as ToolJobState
  }

  const scheduler: ToolScheduler = {
    async submit(input) {
      const id = genId()
      const now = Date.now()
      const job: ToolJob = { ...input, id, submittedAt: now, attempt: 1 }
      const state: ToolJobState = { job, status: "pending", submittedAt: now }
      await storeJob(state)

      // Push to queue
      const qk = queueKey(input.projectId, input.resourceClass)
      await redis.rpush(qk, id)

      return { jobId: id, accepted: true }
    },

    async awaitResult(jobId, timeoutMs) {
      // Poll for result
      const deadline = Date.now() + (timeoutMs ?? 60000)
      while (Date.now() < deadline) {
        const state = await loadJob(jobId)
        if (!state) return { status: "failed", jobId, errorKind: "NOT_FOUND", message: `Job ${jobId} not found`, retryable: false }
        if (state.result) return state.result
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, 200)
        await promise
      }
      return { status: "timed_out", jobId, timeoutMs: timeoutMs ?? 60000 }
    },

    async cancel(jobId, reason) {
      const state = await loadJob(jobId)
      if (!state) return
      state.status = "cancelled"
      state.result = { status: "cancelled", jobId, reason }
      state.completedAt = Date.now()
      await storeJob(state)
      // Decrement semaphore if running
      const semKey = semaphoreKey(state.job.projectId, state.job.resourceClass)
      const count = await redis.get(semKey)
      if (count && parseInt(count) > 0) {
        await redis.decr(semKey)
      }
    },

    async getState(jobId) {
      return loadJob(jobId)
    },

    async listJobs(projectId) {
      const keys = await redis.keys(`tool:job:*`)
      const result: ToolJobState[] = []
      for (const key of keys) {
        const raw = await redis.get(key)
        if (raw) {
          const state = JSON.parse(raw) as ToolJobState
          if (!projectId || state.job.projectId === projectId) {
            result.push(state)
          }
        }
      }
      return result
    },

    async backpressure(projectId) {
      const result: BackpressureState[] = []
      const classes: ResourceClass[] = ["read_light", "search_medium", "cpu_heavy", "io_heavy", "exclusive_repo", "network"]
      for (const rc of classes) {
        const qk = queueKey(projectId, rc)
        const queued = await redis.llen(qk)
        const sk = semaphoreKey(projectId, rc)
        const activeRaw = await redis.get(sk)
        const active = activeRaw ? parseInt(activeRaw) : 0
        const limit = RESOURCE_CLASS_CONCURRENCY[rc]
        result.push({
          resourceClass: rc,
          queued,
          active,
          limit,
          policy: queued > limit * 2 ? "slow_down" : "accept",
        })
      }
      return result
    },

    async canAdmit(projectId, rc) {
      const sk = semaphoreKey(projectId, rc)
      const raw = await redis.get(sk)
      const current = raw ? parseInt(raw) : 0
      return current < RESOURCE_CLASS_CONCURRENCY[rc]
    },

    async reap(ageMs) {
      const keys = await redis.keys(`tool:job:*`)
      let count = 0
      const cutoff = Date.now() - ageMs
      for (const key of keys) {
        const raw = await redis.get(key)
        if (raw) {
          const state = JSON.parse(raw) as ToolJobState
          if (state.completedAt && state.completedAt < cutoff) {
            await redis.del(key)
            count++
          }
        }
      }
      return count
    },

    async dispose() {
      await redis.quit()
    },
  }

  return scheduler
}
