/**
 * Tribunus Bootstrap Control Plane Schema
 * 
 * Hierarchy: Project -> Campaign -> Mission -> Lane -> Task -> Checkpoint -> Receipt
 * 
 * This is a RELATIONAL schema (SQLite/PGlite), separate from Mnemopi memory.
 * Memory links connect control plane entities to Mnemopi banks.
 * 
 * Hardening: Foreign keys enabled, unique constraints, PRAGMA foreign_keys = ON
 */

// ============================================================================
// ENTITY TYPES
// ============================================================================

export interface ControlPlaneEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface Project extends ControlPlaneEntity {
  type: "project";
  name: string;
  slug: string; // Unique within system
  description: string;
  version: string;
  status: "active" | "archived" | "planning";
}

export interface Campaign extends ControlPlaneEntity {
  type: "campaign";
  projectId: string;
  name: string;
  slug: string; // Unique within project
  description: string;
  objective: string;
  status: "not_started" | "in_progress" | "blocked" | "completed" | "abandoned";
  startDate?: string;
  endDate?: string;
  memoryBank: string;
}

export interface Mission extends ControlPlaneEntity {
  type: "mission";
  campaignId: string;
  name: string;
  slug: string; // Unique within campaign
  description: string;
  purpose: string;
  status: "not_started" | "in_progress" | "blocked" | "completed" | "abandoned";
  priority: number; // 0-100
  acceptanceCriteria: string[];
  memoryBank: string;
}

export interface Lane extends ControlPlaneEntity {
  type: "lane";
  missionId: string;
  name: string;
  slug: string; // Unique within mission
  description: string;
  scope: string; // Scope for single-writer-per-scope rule
  status: "idle" | "active" | "paused" | "completed" | "failed";
  isReadOnly: boolean; // Default false
  
  // Lease information
  currentLeaseHolder?: string; // Agent/process holding the lease
  leaseAcquiredAt?: string;
  leaseExpiresAt?: string;
  
  // Write scope paths (for conflict detection)
  writePaths?: string[]; // Paths this lane can write to
  
  // Stream/queue binding (for Valkey integration)
  streamKey?: string;
  consumerGroup?: string;
}

export interface Task extends ControlPlaneEntity {
  type: "task";
  laneId: string;
  missionId: string;
  name: string;
  slug: string; // Unique within mission
  description: string;
  status: "pending" | "in_progress" | "blocked" | "completed" | "failed" | "skipped";
  priority: number; // 0-100
  estimatedEffort?: string;
  actualEffort?: string;
  
  // Dependencies
  dependsOn: string[]; // Task IDs this task depends on
  blocks: string[]; // Task IDs this task blocks
  
  // Execution context
  assignedTo?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface Checkpoint extends ControlPlaneEntity {
  type: "checkpoint";
  taskId: string;
  laneId: string;
  missionId: string;
  name: string;
  description: string;
  
  // Checkpoint state
  stateSnapshot: Record<string, unknown>;
  gitCommit?: string;
  gitBranch?: string;
  gitDirty?: boolean;
  
  // Memory links
  memoryBank: string;
  memoryQuery?: string;
  memoryResults?: Array<{ id: string; content: string; score: number }>;
  memoryContextStatus?: "success" | "failed" | "degraded"; // For hardening
  
  // Lineage verification
  projectId?: string;
  campaignId?: string;
  
  status: "created" | "validated" | "failed" | "deprecated";
}

export interface Receipt extends ControlPlaneEntity {
  type: "receipt";
  
  // Operation details
  operation: string;
  entityType: string;
  entityId: string;
  
  // State transition info
  previousState?: Record<string, unknown>;
  nextState?: Record<string, unknown>;
  
  // Success/failure
  success: boolean;
  error?: string;
  verdict?: "pass" | "fail" | "warning" | "info";
  
  // Timing
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  
  // Memory linkage
  memoryBank?: string;
  memoryOperationId?: string;
  
  // Checkpoint linkage
  checkpointId?: string;
  
  // Input/output
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  
  // Actor
  actor?: string;
  source?: string;
  
  // Verification
  verifiedBy?: string;
  verifiedAt?: string;
  verificationHash?: string;
}

export interface MemoryLink extends ControlPlaneEntity {
  type: "memory_link";
  
  // Control plane entity
  entityType: string;
  entityId: string;
  
  // Memory reference
  memoryBank: string;
  memoryId: string; // The Mnemopi memory ID
  
  // Relationship type
  relationship: "context" | "decision" | "lesson" | "constraint" | "requirement";
  
  // Relevance
  relevanceScore: number; // 0-1
  notes?: string;
}

export interface Event extends ControlPlaneEntity {
  type: "event";
  
  // What changed
  entityType: string;
  entityId: string;
  action: "create" | "update" | "delete" | "transition";
  
  // Before/after state
  previousState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  changedFields?: string[];
  
  // Metadata
  source: string; // "user" | "agent" | "system" | "script"
  actor?: string;
  ipAddress?: string;
  userAgent?: string;
}

// ============================================================================
// DATABASE SCHEMA (SQL)
// ============================================================================

export const SCHEMA_VERSION = "1.0.0";

// Enable foreign key constraints
export const PRAGMA_FOREIGN_KEYS_ON = "PRAGMA foreign_keys = ON";

export const CREATE_TABLE_PROJECTS = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'project',
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    version TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    createdBy TEXT NOT NULL
  )
`;

export const CREATE_TABLE_CAMPAIGNS = `
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'campaign',
    projectId TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    objective TEXT,
    status TEXT NOT NULL DEFAULT 'not_started',
    startDate TEXT,
    endDate TEXT,
    memoryBank TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    createdBy TEXT NOT NULL,
    FOREIGN KEY (projectId) REFERENCES projects(id),
    UNIQUE(projectId, slug)
  )
`;

export const CREATE_TABLE_MISSIONS = `
  CREATE TABLE IF NOT EXISTS missions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'mission',
    campaignId TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    purpose TEXT,
    status TEXT NOT NULL DEFAULT 'not_started',
    priority INTEGER NOT NULL DEFAULT 50,
    acceptanceCriteria TEXT NOT NULL DEFAULT '[]',
    memoryBank TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    createdBy TEXT NOT NULL,
    FOREIGN KEY (campaignId) REFERENCES campaigns(id),
    UNIQUE(campaignId, slug)
  )
`;

export const CREATE_TABLE_LANES = `
  CREATE TABLE IF NOT EXISTS lanes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'lane',
    missionId TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    scope TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    isReadOnly INTEGER NOT NULL DEFAULT 0,
    currentLeaseHolder TEXT,
    leaseAcquiredAt TEXT,
    leaseExpiresAt TEXT,
    writePaths TEXT NOT NULL DEFAULT '[]',
    streamKey TEXT,
    consumerGroup TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    createdBy TEXT NOT NULL,
    FOREIGN KEY (missionId) REFERENCES missions(id),
    UNIQUE(missionId, slug)
  )
`;

export const CREATE_TABLE_TASKS = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'task',
    laneId TEXT NOT NULL,
    missionId TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 50,
    estimatedEffort TEXT,
    actualEffort TEXT,
    dependsOn TEXT NOT NULL DEFAULT '[]',
    blocks TEXT NOT NULL DEFAULT '[]',
    assignedTo TEXT,
    startedAt TEXT,
    completedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    createdBy TEXT NOT NULL,
    FOREIGN KEY (laneId) REFERENCES lanes(id),
    FOREIGN KEY (missionId) REFERENCES missions(id),
    UNIQUE(missionId, slug)
  )
`;

export const CREATE_TABLE_CHECKPOINTS = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'checkpoint',
    taskId TEXT NOT NULL,
    laneId TEXT NOT NULL,
    missionId TEXT NOT NULL,
    projectId TEXT,
    campaignId TEXT,
    name TEXT NOT NULL,
    description TEXT,
    stateSnapshot TEXT NOT NULL,
    gitCommit TEXT,
    gitBranch TEXT,
    gitDirty INTEGER DEFAULT 0,
    memoryBank TEXT NOT NULL,
    memoryQuery TEXT,
    memoryResults TEXT,
    memoryContextStatus TEXT DEFAULT 'success',
    status TEXT NOT NULL DEFAULT 'created',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    createdBy TEXT NOT NULL,
    FOREIGN KEY (taskId) REFERENCES tasks(id),
    FOREIGN KEY (laneId) REFERENCES lanes(id),
    FOREIGN KEY (missionId) REFERENCES missions(id),
    FOREIGN KEY (projectId) REFERENCES projects(id),
    FOREIGN KEY (campaignId) REFERENCES campaigns(id)
  )
`;

export const CREATE_TABLE_RECEIPTS = `
  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'receipt',
    operation TEXT NOT NULL,
    entityType TEXT NOT NULL,
    entityId TEXT NOT NULL,
    previousState TEXT,
    nextState TEXT,
    success INTEGER NOT NULL,
    error TEXT,
    verdict TEXT,
    startedAt TEXT,
    completedAt TEXT,
    durationMs INTEGER,
    memoryBank TEXT,
    memoryOperationId TEXT,
    checkpointId TEXT,
    actor TEXT,
    source TEXT,
    payload TEXT,
    verifiedBy TEXT,
    verifiedAt TEXT,
    verificationHash TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    createdBy TEXT NOT NULL,
    FOREIGN KEY (checkpointId) REFERENCES checkpoints(id)
  )
`;

export const CREATE_TABLE_MEMORY_LINKS = `
  CREATE TABLE IF NOT EXISTS memory_links (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'memory_link',
    entityType TEXT NOT NULL,
    entityId TEXT NOT NULL,
    memoryBank TEXT NOT NULL,
    memoryId TEXT NOT NULL,
    relationship TEXT NOT NULL,
    relevanceScore REAL NOT NULL DEFAULT 0.0,
    notes TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    createdBy TEXT NOT NULL,
    UNIQUE(entityType, entityId, memoryBank, memoryId)
  )
`;

export const CREATE_TABLE_EVENTS = `
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'event',
    entityType TEXT NOT NULL,
    entityId TEXT NOT NULL,
    action TEXT NOT NULL,
    previousState TEXT,
    newState TEXT,
    changedFields TEXT,
    source TEXT NOT NULL,
    actor TEXT,
    ipAddress TEXT,
    userAgent TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    createdBy TEXT NOT NULL
  )
`;

export const CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_campaigns_project ON campaigns(projectId);
  CREATE INDEX IF NOT EXISTS idx_campaigns_slug ON campaigns(projectId, slug);
  CREATE INDEX IF NOT EXISTS idx_missions_campaign ON missions(campaignId);
  CREATE INDEX IF NOT EXISTS idx_missions_slug ON missions(campaignId, slug);
  CREATE INDEX IF NOT EXISTS idx_lanes_mission ON lanes(missionId);
  CREATE INDEX IF NOT EXISTS idx_lanes_slug ON lanes(missionId, slug);
  CREATE INDEX IF NOT EXISTS idx_tasks_lane ON tasks(laneId);
  CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(missionId);
  CREATE INDEX IF NOT EXISTS idx_tasks_slug ON tasks(missionId, slug);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(taskId);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_lane ON checkpoints(laneId);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_mission ON checkpoints(missionId);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(projectId);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_campaign ON checkpoints(campaignId);
  CREATE INDEX IF NOT EXISTS idx_receipts_entity ON receipts(entityType, entityId);
  CREATE INDEX IF NOT EXISTS idx_receipts_checkpoint ON receipts(checkpointId);
  CREATE INDEX IF NOT EXISTS idx_receipts_success ON receipts(success);
  CREATE INDEX IF NOT EXISTS idx_memory_links_entity ON memory_links(entityType, entityId);
  CREATE INDEX IF NOT EXISTS idx_memory_links_memory ON memory_links(memoryBank, memoryId);
  CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entityType, entityId);
`;

export const ALL_SCHEMA = [
  PRAGMA_FOREIGN_KEYS_ON,
  CREATE_TABLE_PROJECTS,
  CREATE_TABLE_CAMPAIGNS,
  CREATE_TABLE_MISSIONS,
  CREATE_TABLE_LANES,
  CREATE_TABLE_TASKS,
  CREATE_TABLE_CHECKPOINTS,
  CREATE_TABLE_RECEIPTS,
  CREATE_TABLE_MEMORY_LINKS,
  CREATE_TABLE_EVENTS,
  CREATE_INDEXES,
];
