/**
 * Tool Runtime Bridge — connects the tool execution scheduler to the actual tool runtime.
 *
 * Agents submit tool intents through this bridge instead of calling tools directly.
 * The bridge handles: cache lookup, scheduler admission, single-flight dedup, execution, result caching.
 */

import type { ToolScheduler, ToolJobResult, ResourceClass } from "./tool-scheduler"
import type { ToolCache, ToolCacheKey } from "./tool-cache"
import { buildCacheKey, isCacheable, ttlForResourceClass } from "./tool-cache"
import { classifyTool } from "./tool-classification"
import type { RealtimeEventBridge } from "./realtime-event-bridge"

export interface ToolBridgeOptions {
  scheduler: ToolScheduler
  cache?: ToolCache
  events?: RealtimeEventBridge
}

export type ToolExecutor = (toolName: string, args: unknown) => Promise<unknown>

export interface ToolCallRequest {
  toolName: string
  args: unknown
  agentId: string
  projectId: string
  repoRoot: string
  idempotencyKey?: string
}

export function createToolRuntimeBridge(opts: ToolBridgeOptions) {
  const { scheduler, cache, events } = opts

  async function execute(request: ToolCallRequest, executor: ToolExecutor): Promise<ToolJobResult> {
    const rc = classifyTool(request.toolName)
    const cacheable = isCacheable(request.toolName)

    // ── Cache lookup ──────────────────────────────────
    if (cache && cacheable && request.idempotencyKey) {
      const ck = buildCacheKey({
        toolName: request.toolName,
        idempotencyKey: request.idempotencyKey,
        label: `${request.toolName}(${request.agentId})`,
      })
      const cached = await cache.get(ck)
      if (cached) {
        events?.emit({
          kind: "tool.job.completed",
          projectId: request.projectId,
          agentId: request.agentId,
          payload: { toolName: request.toolName, source: "cache" },
          timestamp: Date.now(),
        })
        return { status: "completed", jobId: ck.key, result: cached.result, durationMs: 0 }
      }
    }

    // ── Scheduler admission ───────────────────────────
    const canRun = await scheduler.canAdmit(request.projectId, rc)
    if (!canRun) {
      // Queue the job
      const { jobId } = await scheduler.submit({
        agentId: request.agentId,
        projectId: request.projectId,
        repoRoot: request.repoRoot,
        toolName: request.toolName,
        args: request.args,
        resourceClass: rc,
        priority: "normal",
        timeoutMs: 300_000,
        idempotencyKey: request.idempotencyKey,
      })

      events?.emit({
        kind: "tool.job.submitted",
        projectId: request.projectId,
        agentId: request.agentId,
        jobId,
        payload: { toolName: request.toolName, resourceClass: rc, queued: true },
        timestamp: Date.now(),
      })

      return scheduler.awaitResult(jobId, 300_000)
    }

    // ── Execute ───────────────────────────────────────
    const { jobId } = await scheduler.submit({
      agentId: request.agentId,
      projectId: request.projectId,
      repoRoot: request.repoRoot,
      toolName: request.toolName,
      args: request.args,
      resourceClass: rc,
      priority: "normal",
      timeoutMs: 300_000,
      idempotencyKey: request.idempotencyKey,
    })

    events?.emit({
      kind: "tool.job.started",
      projectId: request.projectId,
      agentId: request.agentId,
      jobId,
      payload: { toolName: request.toolName, resourceClass: rc },
      timestamp: Date.now(),
    })

    const start = Date.now()
    try {
      const result = await executor(request.toolName, request.args)
      const durationMs = Date.now() - start
      const jobResult: ToolJobResult = { status: "completed", jobId, result, durationMs }

      // Cache the result
      if (cache && cacheable && request.idempotencyKey) {
        const ck = buildCacheKey({
          toolName: request.toolName,
          idempotencyKey: request.idempotencyKey,
          label: `${request.toolName}(${request.agentId})`,
        })
        await cache.set(ck, result, ttlForResourceClass(rc))
      }

      events?.emit({
        kind: "tool.job.completed",
        projectId: request.projectId,
        agentId: request.agentId,
        jobId,
        payload: { toolName: request.toolName, durationMs },
        timestamp: Date.now(),
      })

      return jobResult
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const jobResult: ToolJobResult = { status: "failed", jobId, errorKind: "EXECUTION_ERROR", message, retryable: false }

      events?.emit({
        kind: "tool.job.failed",
        projectId: request.projectId,
        agentId: request.agentId,
        jobId,
        payload: { toolName: request.toolName, error: message },
        timestamp: Date.now(),
      })

      return jobResult
    }
  }

  async function getBackpressure(projectId: string) {
    return scheduler.backpressure(projectId)
  }

  async function dispose() {
    await scheduler.dispose()
    await cache?.dispose()
    await events?.dispose()
  }

  return { execute, getBackpressure, dispose }
}
