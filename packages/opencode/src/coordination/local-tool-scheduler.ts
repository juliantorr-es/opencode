import type { ToolScheduler, ToolJob, ToolJobResult, ToolJobState, BackpressureState, ResourceClass } from "./tool-scheduler"
import { RESOURCE_CLASS_CONCURRENCY } from "./tool-scheduler"
import type { CoordinationFabric } from "./fabric"

interface ActiveJob {
  state: ToolJobState
  resolve: ((result: ToolJobResult) => void)[]
}

export function createLocalToolScheduler(fabric: CoordinationFabric): ToolScheduler {
  const jobs = new Map<string, ActiveJob>()
  const queues = new Map<string, ToolJobState[]>() // key = `${projectId}:${resourceClass}`
  const active = new Map<string, number>()         // key = `${projectId}:${resourceClass}`
  let nextId = 1

  function queueKey(projectId: string, rc: ResourceClass): string {
    return `${projectId}:${rc}`
  }

  function genId(): string {
    return `job_${Date.now()}_${nextId++}`
  }

  async function tryAdmit(projectId: string, rc: ResourceClass): Promise<void> {
    const key = queueKey(projectId, rc)
    const current = active.get(key) ?? 0
    const limit = RESOURCE_CLASS_CONCURRENCY[rc]
    if (current >= limit) return
    const queue = queues.get(key) ?? []
    const next = queue.shift()
    if (!next) return
    queues.set(key, queue)
    active.set(key, current + 1)
    executeJob(next)
  }

  async function executeJob(state: ToolJobState): Promise<void> {
    const activeJob = jobs.get(state.job.id)
    if (!activeJob) return
    state.status = "running"
    state.startedAt = Date.now()
    // The actual execution happens externally — the scheduler just tracks state.
    // Caller calls awaitResult() which waits for resolve().
  }

  function completeJob(jobId: string, result: ToolJobResult): void {
    const activeJob = jobs.get(jobId)
    if (!activeJob) return
    activeJob.state.status = result.status
    activeJob.state.completedAt = Date.now()
    activeJob.state.result = result
    for (const resolve of activeJob.resolve) resolve(result)
    activeJob.resolve.length = 0
    // Decrement active count
    const key = queueKey(activeJob.state.job.projectId, activeJob.state.job.resourceClass)
    const current = active.get(key) ?? 0
    active.set(key, Math.max(0, current - 1))
    // Try to admit next
    tryAdmit(activeJob.state.job.projectId, activeJob.state.job.resourceClass)
  }

  const scheduler: ToolScheduler = {
    async submit(input) {
      const id = genId()
      const now = Date.now()
      const job: ToolJob = {
        ...input,
        id,
        submittedAt: now,
        attempt: 1,
      }
      const state: ToolJobState = { job, status: "pending", submittedAt: now }
      jobs.set(id, { state, resolve: [] })

      const key = queueKey(input.projectId, input.resourceClass)
      if (!queues.has(key)) queues.set(key, [])
      queues.get(key)!.push(state)

      await tryAdmit(input.projectId, input.resourceClass)
      // Admit the job by marking it as admitted (actual execution is external)
      if (state.status === "pending") {
        state.status = "admitted"
        state.admittedAt = now
      }

      return { jobId: id, accepted: true }
    },

    async awaitResult(jobId, timeoutMs) {
      const activeJob = jobs.get(jobId)
      if (!activeJob) return { status: "failed", jobId, errorKind: "NOT_FOUND", message: `Job ${jobId} not found`, retryable: false }
      if (activeJob.state.result) return activeJob.state.result

      return new Promise<ToolJobResult>((resolve) => {
        activeJob.resolve.push(resolve)
        if (timeoutMs) {
          setTimeout(() => {
            const idx = activeJob.resolve.indexOf(resolve)
            if (idx >= 0) {
              activeJob.resolve.splice(idx, 1)
              resolve({ status: "timed_out", jobId, timeoutMs })
            }
          }, timeoutMs)
        }
      })
    },

    async cancel(jobId, reason) {
      const result: ToolJobResult = { status: "cancelled", jobId, reason }
      completeJob(jobId, result)
    },

    async getState(jobId) {
      return jobs.get(jobId)?.state
    },

    async listJobs(projectId) {
      const all: ToolJobState[] = []
      for (const [, activeJob] of jobs) {
        if (!projectId || activeJob.state.job.projectId === projectId) {
          all.push(activeJob.state)
        }
      }
      return all
    },

    async backpressure(projectId) {
      const result: BackpressureState[] = []
      const classes: ResourceClass[] = ["read_light", "search_medium", "cpu_heavy", "io_heavy", "exclusive_repo", "network"]
      for (const rc of classes) {
        const key = queueKey(projectId, rc)
        const queued = (queues.get(key) ?? []).length
        const act = active.get(key) ?? 0
        const limit = RESOURCE_CLASS_CONCURRENCY[rc]
        result.push({
          resourceClass: rc,
          queued,
          active: act,
          limit,
          policy:
            queued > limit * 4 ? "reject_low_priority" :
            queued > limit * 2 ? "slow_down" :
            "accept",
        })
      }
      return result
    },

    async canAdmit(projectId, rc) {
      const key = queueKey(projectId, rc)
      const current = active.get(key) ?? 0
      return current < RESOURCE_CLASS_CONCURRENCY[rc]
    },

    async reap(ageMs) {
      const cutoff = Date.now() - ageMs
      let count = 0
      for (const [id, activeJob] of jobs) {
        const done = activeJob.state.completedAt
        if (done && done <= cutoff) {
          jobs.delete(id)
          count++
        }
      }
      return count
    },

    async dispose() {
      jobs.clear()
      queues.clear()
      active.clear()
    },
  }

  return scheduler
}
