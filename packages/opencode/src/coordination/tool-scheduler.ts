/**
 * Tool Execution Scheduler — prevents agent swarms from saturating the machine.
 *
 * Heavy tools (typecheck, build, test, migration) go through the scheduler.
 * Light read tools can bypass or use generous concurrency limits.
 * The scheduler uses CoordinationFabric for live queues/leases/backpressure.
 */

// ── Resource Classes ─────────────────────────────────────

export type ResourceClass =
  | "read_light"       // read_file, list files, small grep
  | "search_medium"    // ripgrep, symbol search, tree-sitter parse
  | "cpu_heavy"        // typecheck, build, large test suite
  | "io_heavy"         // full repo scan, artifact ingestion, projection rebuild
  | "exclusive_repo"   // migration, package install, generated file rewrite, git checkpoint
  | "network"          // provider calls, GitHub calls, remote docs

export const RESOURCE_CLASS_CONCURRENCY: Record<ResourceClass, number> = {
  read_light: 32,
  search_medium: 4,
  cpu_heavy: 1,
  io_heavy: 1,
  exclusive_repo: 1,
  network: 8,
}

// ── Tool Job ──────────────────────────────────────────────

export interface ToolJob {
  id: string
  agentId: string
  missionId?: string
  projectId: string
  repoRoot: string
  toolName: string
  args: unknown
  resourceClass: ResourceClass
  priority: "low" | "normal" | "high" | "critical"
  requiresClaim?: string[]
  timeoutMs: number
  submittedAt: number
  attempt: number
  /** Content-addressed idempotency key for deduplication */
  idempotencyKey?: string
}

export type ToolJobResult =
  | { status: "completed"; jobId: string; result: unknown; durationMs: number }
  | { status: "failed"; jobId: string; errorKind: string; message: string; retryable: boolean }
  | { status: "cancelled"; jobId: string; reason: string }
  | { status: "timed_out"; jobId: string; timeoutMs: number }

export type ToolJobStatus = "pending" | "admitted" | "running" | "completed" | "failed" | "cancelled" | "timed_out"

export interface ToolJobState {
  job: ToolJob
  status: ToolJobStatus
  submittedAt: number
  admittedAt?: number
  startedAt?: number
  completedAt?: number
  workerId?: string
  result?: ToolJobResult
}

// ── Backpressure ──────────────────────────────────────────

export interface BackpressureState {
  resourceClass: ResourceClass
  queued: number
  active: number
  limit: number
  estimatedDelayMs?: number
  policy: "accept" | "slow_down" | "reject_low_priority"
}

// ── Scheduler Interface ──────────────────────────────────

export interface ToolScheduler {
  /** Submit a tool job. Returns immediately with job ID. */
  submit(job: Omit<ToolJob, "id" | "submittedAt" | "attempt">): Promise<{ jobId: string; accepted: boolean; reason?: string }>

  /** Wait for a submitted job to complete or fail. */
  awaitResult(jobId: string, timeoutMs?: number): Promise<ToolJobResult>

  /** Cancel a pending or running job. */
  cancel(jobId: string, reason: string): Promise<void>

  /** Get current state of a job. */
  getState(jobId: string): Promise<ToolJobState | undefined>

  /** List all jobs for a project (or all if no projectId). */
  listJobs(projectId?: string): Promise<ToolJobState[]>

  /** Get backpressure for all resource classes in a project. */
  backpressure(projectId: string): Promise<BackpressureState[]>

  /** Check if a new job of this class can be admitted now. */
  canAdmit(projectId: string, resourceClass: ResourceClass): Promise<boolean>

  /** Clean up completed/failed/cancelled jobs older than ageMs. */
  reap(ageMs: number): Promise<number>

  dispose(): Promise<void>
}
