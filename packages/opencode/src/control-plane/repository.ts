/**
 * Control-Plane Repository Interface
 *
 * Clean repository pattern that abstracts the storage backend for all
 * control-plane entities. Both filesystem (SQLite/JSON) and PGlite
 * implementations satisfy this interface, enabling the dual-read
 * characterization and shadow-write verification during migration.
 *
 * Doctrine:
 * - Callers never touch the storage backend directly
 * - Repository enforces transaction boundaries, constraints, and indices
 * - After migration, the PGlite implementation is the sole active backend
 * - The filesystem implementation remains for rollback during migration
 */
import { Effect } from "effect"

// ── Entity Types ─────────────────────────────────────────────────────────────

export interface CampaignEntity {
  id: string
  name: string
  slug: string
  description: string
  objective: string
  status: string
  maturity: string
  horizon: string
  priority: number
  startDate?: string
  endDate?: string
  memoryBank: string
  followOnCampaigns: string[]
  tags: string[]
  authors: string[]
  createdAt: string
  updatedAt: string
}

export interface MissionEntity {
  id: string
  campaignId: string
  name: string
  slug: string
  description: string
  purpose: string
  status: string
  maturity: string
  horizon: string
  priority: number
  dependsOn: string[]
  unlocks: string[]
  authorityScope: string
  allowedPaths: string[]
  requiredEvidence: string[]
  acceptanceGates: string[]
  acceptanceCriteria: string[]
  rollbackStrategy: string
  recoveryStrategy: string
  automationMode: string
  maximumAttempts: number
  escalationPolicy: string
  maturityTarget: string
  tags: string[]
  authors: string[]
  createdAt: string
  updatedAt: string
}

export interface LaneEntity {
  id: string
  missionId: string
  name: string
  slug: string
  description: string
  scope: string
  status: string
  maturity: string
  isReadOnly: boolean
  writePaths: string[]
  streamKey?: string
  consumerGroup?: string
  concurrencyGroup?: string
  leaseHolder?: string
  leaseAcquiredAt?: number
  leaseExpiresAt?: number
  tags: string[]
  authors: string[]
  createdAt: string
  updatedAt: string
}

export interface TaskEntity {
  id: string
  laneId: string
  missionId: string
  name: string
  slug: string
  description: string
  status: string
  maturity: string
  horizon: string
  priority: number
  riskClass: string
  estimatedEffort?: string
  actualEffort?: string
  assignedTo?: string
  startedAt?: number
  completedAt?: number
  dependsOn: string[]
  blocks: string[]
  acceptanceCriteria: string[]
  expectedOutputs: string[]
  verificationCommands: string[]
  evidenceRequirements: string[]
  mutationScope: string[]
  retryPolicy: { max_retries: number; backoff_strategy: string }
  failureClassification?: string
  nextSafeAction?: string
  tags: string[]
  authors: string[]
  createdAt: string
  updatedAt: string
}

// ── Query Types ──────────────────────────────────────────────────────────────

export interface EntityQuery {
  status?: string
  maturity?: string
  horizon?: string
  priority?: number
  limit?: number
  offset?: number
  orderBy?: string
  orderDir?: "asc" | "desc"
}

export interface CampaignQuery extends EntityQuery {
  campaignId?: string
}

export interface MissionQuery extends EntityQuery {
  campaignId?: string
}

export interface LaneQuery extends EntityQuery {
  missionId?: string
}

export interface TaskQuery extends EntityQuery {
  laneId?: string
  missionId?: string
  assignedTo?: string
  riskClass?: string
}

// ── Repository Interface ─────────────────────────────────────────────────────

export interface ControlPlaneRepository {
  // Campaign
  getCampaign(id: string): Effect.Effect<CampaignEntity | null, Error>
  listCampaigns(query?: CampaignQuery): Effect.Effect<CampaignEntity[], Error>
  createCampaign(entity: CampaignEntity): Effect.Effect<CampaignEntity, Error>
  updateCampaign(id: string, partial: Partial<CampaignEntity>): Effect.Effect<CampaignEntity, Error>
  deleteCampaign(id: string): Effect.Effect<void, Error>

  // Mission
  getMission(id: string): Effect.Effect<MissionEntity | null, Error>
  listMissions(query?: MissionQuery): Effect.Effect<MissionEntity[], Error>
  createMission(entity: MissionEntity): Effect.Effect<MissionEntity, Error>
  updateMission(id: string, partial: Partial<MissionEntity>): Effect.Effect<MissionEntity, Error>
  deleteMission(id: string): Effect.Effect<void, Error>

  // Lane
  getLane(id: string): Effect.Effect<LaneEntity | null, Error>
  listLanes(query?: LaneQuery): Effect.Effect<LaneEntity[], Error>
  createLane(entity: LaneEntity): Effect.Effect<LaneEntity, Error>
  updateLane(id: string, partial: Partial<LaneEntity>): Effect.Effect<LaneEntity, Error>
  deleteLane(id: string): Effect.Effect<void, Error>
  acquireLease(laneId: string, holderId: string, ttlMs: number): Effect.Effect<boolean, Error>
  releaseLease(laneId: string, holderId: string): Effect.Effect<boolean, Error>

  // Task
  getTask(id: string): Effect.Effect<TaskEntity | null, Error>
  listTasks(query?: TaskQuery): Effect.Effect<TaskEntity[], Error>
  createTask(entity: TaskEntity): Effect.Effect<TaskEntity, Error>
  updateTask(id: string, partial: Partial<TaskEntity>): Effect.Effect<TaskEntity, Error>
  deleteTask(id: string): Effect.Effect<void, Error>

  // Transaction
  transaction<R, E>(fn: (repo: ControlPlaneRepository) => Effect.Effect<R, E>): Effect.Effect<R, E>
}

// ── Error Types ──────────────────────────────────────────────────────────────

export class EntityNotFoundError extends Error {
  readonly _tag = "EntityNotFoundError"
  constructor(entityType: string, entityId: string) {
    super(`${entityType} not found: ${entityId}`)
  }
}

export class ConstraintViolationError extends Error {
  readonly _tag = "ConstraintViolationError"
  constructor(constraint: string, detail: string) {
    super(`Constraint violation: ${constraint} — ${detail}`)
  }
}

export class LeaseConflictError extends Error {
  readonly _tag = "LeaseConflictError"
  constructor(laneId: string, currentHolder: string) {
    super(`Lease conflict on lane ${laneId}: held by ${currentHolder}`)
  }
}

export class MigrationInProgressError extends Error {
  readonly _tag = "MigrationInProgressError"
  constructor() {
    super("Control plane migration is in progress — writes are blocked")
  }
}
