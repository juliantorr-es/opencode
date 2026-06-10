/**
 * Tribunus Control Plane CRUD Tools
 * Receipt-first operations for all control plane entities.
 * 
 * Hardening: Foreign keys enabled, valid lineage enforced, fails closed on invalid inputs
 */

import { Database } from "bun:sqlite";
import type {
  Project,
  Campaign,
  Mission,
  Lane,
  Task,
  Checkpoint,
  Receipt as ReceiptType,
  MemoryLink,
  Event,
} from "./schema";
import { ALL_SCHEMA, PRAGMA_FOREIGN_KEYS_ON } from "./schema";

// ============================================================================
// DATABASE MANAGEMENT
// ============================================================================

let db: Database | null = null;
let currentDbPath: string = "tribunus-control-plane.db";

function getDb(dbPath: string = "tribunus-control-plane.db"): Database {
  if (!db || currentDbPath !== dbPath) {
    db = new Database(dbPath, { create: true });
    currentDbPath = dbPath;
    initializeSchema(db);
  }
  return db;
}

function initializeSchema(database: Database): void {
  const version = database.query("PRAGMA user_version").get() as { user_version: number };
  const currentVersion = parseInt(version?.user_version?.toString() || "0");

  if (currentVersion < 1) {
    for (const sql of ALL_SCHEMA) {
      database.exec(sql);
    }
    database.exec(`PRAGMA user_version = 1`);
  }
  
  // Always ensure foreign keys are on for this connection
  database.exec(PRAGMA_FOREIGN_KEYS_ON);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============================================================================
// RECEIPT HELPERS
// ============================================================================

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function generateReceipt<T>(
  operation: string,
  entityType: string,
  entityId: string,
  success: boolean,
  data?: T,
  error?: string,
  verdict?: "pass" | "fail" | "warning" | "info"
): ReceiptType {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    type: "receipt",
    operation,
    entityType,
    entityId,
    input: data as unknown as Record<string, unknown> | undefined,
    output: success ? (data as unknown as Record<string, unknown>) : undefined,
    success,
    error,
    verdict,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
    createdBy: "system",
    source: "control-plane",
    actor: "system",
  };
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

function validateEntityExists(database: Database, table: string, id: string): boolean {
  const result = database.query(`SELECT id FROM ${table} WHERE id = ?`).get(id);
  return result !== null;
}

// ============================================================================
// PROJECT CRUD
// ============================================================================

export function tribunusProjectCreate(
  project: Omit<Project, "id" | "createdAt" | "updatedAt" | "createdBy"> & { slug: string },
  dbPath?: string
): ReceiptType {
  const database = getDb(dbPath);
  const id = generateId();
  const now = new Date().toISOString();

  try {
    // Check for duplicate slug
    const existing = database.query("SELECT id FROM projects WHERE slug = ?").get(project.slug);
    if (existing) {
      return generateReceipt("create", "project", id, false, undefined, 
        `DUPLICATE_SLUG: Project with slug '${project.slug}' already exists (${(existing as { id: string }).id})`,
        "fail");
    }

    const stmt = database.prepare(`
      INSERT INTO projects (id, type, name, slug, description, version, status, createdAt, updatedAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      project.type,
      project.name,
      project.slug,
      project.description,
      project.version,
      project.status,
      now,
      now,
      "system"
    );

    const created = database.query("SELECT * FROM projects WHERE id = ?").get(id) as unknown as Project;
    return generateReceipt("create", "project", id, true, created as unknown as Record<string, unknown>, undefined, "pass");
  } catch (error) {
    return generateReceipt("create", "project", id, false, undefined, String(error), "fail");
  }
}

export function tribunusProjectGet(id: string, dbPath?: string): Project | null {
  const database = getDb(dbPath);
  return database.query("SELECT * FROM projects WHERE id = ?").get(id) as unknown as Project | null;
}

export function tribunusProjectGetBySlug(slug: string, dbPath?: string): Project | null {
  const database = getDb(dbPath);
  return database.query("SELECT * FROM projects WHERE slug = ?").get(slug) as unknown as Project | null;
}

export function tribunusProjectList(dbPath?: string): Project[] {
  const database = getDb(dbPath);
  return database.query("SELECT * FROM projects").all() as unknown as Project[];
}

// ============================================================================
// CAMPAIGN CRUD
// ============================================================================

export function tribunusCampaignCreate(
  campaign: Omit<Campaign, "id" | "createdAt" | "updatedAt" | "createdBy"> & { slug: string; projectId: string },
  dbPath?: string
): ReceiptType {
  const database = getDb(dbPath);
  const id = generateId();
  const now = new Date().toISOString();

  try {
    // Validate project exists
    if (!validateEntityExists(database, "projects", campaign.projectId)) {
      return generateReceipt("create", "campaign", id, false, undefined,
        `INVALID_PARENT: Project '${campaign.projectId}' does not exist`,
        "fail");
    }

    // Check for duplicate slug within project
    const existing = database.query(
      "SELECT id FROM campaigns WHERE projectId = ? AND slug = ?"
    ).get(campaign.projectId, campaign.slug);
    if (existing) {
      return generateReceipt("create", "campaign", id, false, undefined,
        `DUPLICATE_SLUG: Campaign with slug '${campaign.slug}' already exists in project (${(existing as { id: string }).id})`,
        "fail");
    }

    const stmt = database.prepare(`
      INSERT INTO campaigns (id, type, projectId, name, slug, description, objective, status, startDate, endDate, memoryBank, createdAt, updatedAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    (stmt as any).run(
      id,
      campaign.type,
      campaign.projectId,
      campaign.name,
      campaign.slug,
      campaign.description,
      campaign.objective,
      campaign.status,
      campaign.startDate,
      campaign.endDate,
      campaign.memoryBank,
      now,
      now,
      "system"
    );

    const created = database.query("SELECT * FROM campaigns WHERE id = ?").get(id) as unknown as Campaign;
    return generateReceipt("create", "campaign", id, true, created, undefined, "pass");
  } catch (error) {
    return generateReceipt("create", "campaign", id, false, undefined, String(error), "fail");
  }
}

export function tribunusCampaignGet(id: string, dbPath?: string): Campaign | null {
  const database = getDb(dbPath);
  return database.query("SELECT * FROM campaigns WHERE id = ?").get(id) as unknown as Campaign | null;
}

export function tribunusCampaignGetBySlug(projectId: string, slug: string, dbPath?: string): Campaign | null {
  const database = getDb(dbPath);
  return database.query("SELECT * FROM campaigns WHERE projectId = ? AND slug = ?").get(projectId, slug) as unknown as Campaign | null;
}

export function tribunusCampaignList(projectId?: string, dbPath?: string): Campaign[] {
  const database = getDb(dbPath);
  if (projectId) {
    return database.query("SELECT * FROM campaigns WHERE projectId = ?").all(projectId) as unknown as Campaign[];
  }
  return database.query("SELECT * FROM campaigns").all() as unknown as Campaign[];
}

// ============================================================================
// MISSION CRUD
// ============================================================================

export function tribunusMissionCreate(
  mission: Omit<Mission, "id" | "createdAt" | "updatedAt" | "createdBy"> & { slug: string; campaignId: string },
  dbPath?: string
): ReceiptType {
  const database = getDb(dbPath);
  const id = generateId();
  const now = new Date().toISOString();

  try {
    // Validate campaign exists
    if (!validateEntityExists(database, "campaigns", mission.campaignId)) {
      return generateReceipt("create", "mission", id, false, undefined,
        `INVALID_PARENT: Campaign '${mission.campaignId}' does not exist`,
        "fail");
    }

    // Check for duplicate slug within campaign
    const existing = database.query(
      "SELECT id FROM missions WHERE campaignId = ? AND slug = ?"
    ).get(mission.campaignId, mission.slug);
    if (existing) {
      return generateReceipt("create", "mission", id, false, undefined,
        `DUPLICATE_SLUG: Mission with slug '${mission.slug}' already exists in campaign (${(existing as { id: string }).id})`,
        "fail");
    }

    const stmt = database.prepare(`
      INSERT INTO missions (id, type, campaignId, name, slug, description, purpose, status, priority, acceptanceCriteria, memoryBank, createdAt, updatedAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      mission.type,
      mission.campaignId,
      mission.name,
      mission.slug,
      mission.description,
      mission.purpose,
      mission.status,
      mission.priority,
      JSON.stringify(mission.acceptanceCriteria),
      mission.memoryBank,
      now,
      now,
      "system"
    );

    const created = database.query("SELECT * FROM missions WHERE id = ?").get(id) as unknown as Mission;
    return generateReceipt("create", "mission", id, true, created, undefined, "pass");
  } catch (error) {
    return generateReceipt("create", "mission", id, false, undefined, String(error), "fail");
  }
}

export function tribunusMissionGet(id: string, dbPath?: string): Mission | null {
  const database = getDb(dbPath);
  const row = database.query("SELECT * FROM missions WHERE id = ?").get(id) as unknown as Mission | null;
  if (row) {
    row.acceptanceCriteria = JSON.parse(row.acceptanceCriteria as unknown as string);
  }
  return row;
}

export function tribunusMissionGetBySlug(campaignId: string, slug: string, dbPath?: string): Mission | null {
  const database = getDb(dbPath);
  const row = database.query("SELECT * FROM missions WHERE campaignId = ? AND slug = ?").get(campaignId, slug) as unknown as Mission | null;
  if (row) {
    row.acceptanceCriteria = JSON.parse(row.acceptanceCriteria as unknown as string);
  }
  return row;
}

export function tribunusMissionList(campaignId?: string, dbPath?: string): Mission[] {
  const database = getDb(dbPath);
  let rows: Mission[];
  if (campaignId) {
    rows = database.query("SELECT * FROM missions WHERE campaignId = ?").all(campaignId) as unknown as Mission[];
  } else {
    rows = database.query("SELECT * FROM missions").all() as unknown as Mission[];
  }
  return rows.map(row => ({
    ...row,
    acceptanceCriteria: JSON.parse(row.acceptanceCriteria as unknown as string),
  }));
}

// ============================================================================
// LANE CRUD
// ============================================================================

export function tribunusLaneCreate(
  lane: Omit<Lane, "id" | "createdAt" | "updatedAt" | "createdBy"> & { slug: string; missionId: string },
  dbPath?: string
): ReceiptType {
  const database = getDb(dbPath);
  const id = generateId();
  const now = new Date().toISOString();

  try {
    // Validate mission exists
    if (!validateEntityExists(database, "missions", lane.missionId)) {
      return generateReceipt("create", "lane", id, false, undefined,
        `INVALID_PARENT: Mission '${lane.missionId}' does not exist`,
        "fail");
    }

    // Check for duplicate slug within mission
    const existing = database.query(
      "SELECT id FROM lanes WHERE missionId = ? AND slug = ?"
    ).get(lane.missionId, lane.slug);
    if (existing) {
      return generateReceipt("create", "lane", id, false, undefined,
        `DUPLICATE_SLUG: Lane with slug '${lane.slug}' already exists in mission (${(existing as { id: string }).id})`,
        "fail");
    }

    const stmt = database.prepare(`
      INSERT INTO lanes (id, type, missionId, name, slug, description, scope, status, isReadOnly, currentLeaseHolder, leaseAcquiredAt, leaseExpiresAt, writePaths, streamKey, consumerGroup, createdAt, updatedAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      lane.type,
      lane.missionId,
      lane.name,
      lane.slug,
      lane.description,
      lane.scope,
      lane.status,
      lane.isReadOnly ? 1 : 0,
      lane.currentLeaseHolder || null,
      lane.leaseAcquiredAt || null,
      lane.leaseExpiresAt || null,
      JSON.stringify(lane.writePaths || []),
      lane.streamKey || null,
      lane.consumerGroup || null,
      now,
      now,
      "system"
    );

    const created = database.query("SELECT * FROM lanes WHERE id = ?").get(id) as unknown as Lane;
    if (created) {
      created.isReadOnly = Boolean(created.isReadOnly);
      created.writePaths = created.writePaths ? JSON.parse(created.writePaths as unknown as string) : [];
    }
    return generateReceipt("create", "lane", id, true, created, undefined, "pass");
  } catch (error) {
    return generateReceipt("create", "lane", id, false, undefined, String(error), "fail");
  }
}

export function tribunusLaneGet(id: string, dbPath?: string): Lane | null {
  const database = getDb(dbPath);
  const row = database.query("SELECT * FROM lanes WHERE id = ?").get(id) as unknown as Lane | null;
  if (row) {
    row.isReadOnly = Boolean(row.isReadOnly);
    row.writePaths = row.writePaths ? JSON.parse(row.writePaths as unknown as string) : [];
  }
  return row;
}

export function tribunusLaneGetBySlug(missionId: string, slug: string, dbPath?: string): Lane | null {
  const database = getDb(dbPath);
  const row = database.query("SELECT * FROM lanes WHERE missionId = ? AND slug = ?").get(missionId, slug) as unknown as Lane | null;
  if (row) {
    row.isReadOnly = Boolean(row.isReadOnly);
    row.writePaths = row.writePaths ? JSON.parse(row.writePaths as unknown as string) : [];
  }
  return row;
}

export function tribunusLaneList(missionId?: string, dbPath?: string): Lane[] {
  const database = getDb(dbPath);
  let rows: Lane[];
  if (missionId) {
    rows = database.query("SELECT * FROM lanes WHERE missionId = ?").all(missionId) as unknown as Lane[];
  } else {
    rows = database.query("SELECT * FROM lanes").all() as unknown as Lane[];
  }
  return rows.map(row => ({
    ...row,
    isReadOnly: Boolean(row.isReadOnly),
    writePaths: row.writePaths ? JSON.parse(row.writePaths as unknown as string) : [],
  }));
}

// ============================================================================
// TASK CRUD
// ============================================================================

export function tribunusTaskCreate(
  task: Omit<Task, "id" | "createdAt" | "updatedAt" | "createdBy"> & { slug: string; laneId: string; missionId: string },
  dbPath?: string
): ReceiptType {
  const database = getDb(dbPath);
  const id = generateId();
  const now = new Date().toISOString();

  try {
    // Validate mission exists
    if (!validateEntityExists(database, "missions", task.missionId)) {
      return generateReceipt("create", "task", id, false, undefined,
        `INVALID_PARENT: Mission '${task.missionId}' does not exist`,
        "fail");
    }

    // Validate lane exists and belongs to mission
    if (!validateEntityExists(database, "lanes", task.laneId)) {
      return generateReceipt("create", "task", id, false, undefined,
        `INVALID_PARENT: Lane '${task.laneId}' does not exist`,
        "fail");
    }

    // Verify lane belongs to mission
    const lane = database.query("SELECT missionId FROM lanes WHERE id = ?").get(task.laneId) as { missionId: string } | null;
    if (lane && lane.missionId !== task.missionId) {
      return generateReceipt("create", "task", id, false, undefined,
        `INVALID_LINEAGE: Lane '${task.laneId}' belongs to mission '${lane.missionId}', not '${task.missionId}'`,
        "fail");
    }

    // Check for duplicate slug within mission
    const existing = database.query(
      "SELECT id FROM tasks WHERE missionId = ? AND slug = ?"
    ).get(task.missionId, task.slug);
    if (existing) {
      return generateReceipt("create", "task", id, false, undefined,
        `DUPLICATE_SLUG: Task with slug '${task.slug}' already exists in mission (${(existing as { id: string }).id})`,
        "fail");
    }

    const stmt = database.prepare(`
      INSERT INTO tasks (id, type, laneId, missionId, name, slug, description, status, priority, estimatedEffort, actualEffort, dependsOn, blocks, assignedTo, startedAt, completedAt, createdAt, updatedAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      task.type,
      task.laneId,
      task.missionId,
      task.name,
      task.slug,
      task.description,
      task.status,
      task.priority,
      task.estimatedEffort || null,
      task.actualEffort || null,
      JSON.stringify(task.dependsOn),
      JSON.stringify(task.blocks),
      task.assignedTo || null,
      task.startedAt || null,
      task.completedAt || null,
      now,
      now,
      "system"
    );

    const created = database.query("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task;
    return generateReceipt("create", "task", id, true, created, undefined, "pass");
  } catch (error) {
    return generateReceipt("create", "task", id, false, undefined, String(error), "fail");
  }
}

export function tribunusTaskGet(id: string, dbPath?: string): Task | null {
  const database = getDb(dbPath);
  const row = database.query("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task | null;
  if (row) {
    row.dependsOn = JSON.parse(row.dependsOn as unknown as string);
    row.blocks = JSON.parse(row.blocks as unknown as string);
  }
  return row;
}

export function tribunusTaskGetBySlug(missionId: string, slug: string, dbPath?: string): Task | null {
  const database = getDb(dbPath);
  const row = database.query("SELECT * FROM tasks WHERE missionId = ? AND slug = ?").get(missionId, slug) as unknown as Task | null;
  if (row) {
    row.dependsOn = JSON.parse(row.dependsOn as unknown as string);
    row.blocks = JSON.parse(row.blocks as unknown as string);
  }
  return row;
}

export function tribunusTaskList(laneId?: string, missionId?: string, dbPath?: string): Task[] {
  const database = getDb(dbPath);
  let rows: Task[];
  if (laneId && missionId) {
    rows = database.query("SELECT * FROM tasks WHERE laneId = ? AND missionId = ?").all(laneId, missionId) as unknown as Task[];
  } else if (laneId) {
    rows = database.query("SELECT * FROM tasks WHERE laneId = ?").all(laneId) as unknown as Task[];
  } else if (missionId) {
    rows = database.query("SELECT * FROM tasks WHERE missionId = ?").all(missionId) as unknown as Task[];
  } else {
    rows = database.query("SELECT * FROM tasks").all() as unknown as Task[];
  }
  return rows.map(row => ({
    ...row,
    dependsOn: JSON.parse(row.dependsOn as unknown as string),
    blocks: JSON.parse(row.blocks as unknown as string),
  }));
}

// ============================================================================
// CHECKPOINT CRUD
// ============================================================================

export function tribunusCheckpointCreate(
  checkpoint: Omit<Checkpoint, "id" | "createdAt" | "updatedAt" | "createdBy"> & {
    taskId: string;
    laneId: string;
    missionId: string;
  },
  dbPath?: string
): ReceiptType {
  const database = getDb(dbPath);
  const id = generateId();
  const now = new Date().toISOString();

  try {
    // Validate task exists
    if (!validateEntityExists(database, "tasks", checkpoint.taskId)) {
      return generateReceipt("create", "checkpoint", id, false, undefined,
        `INVALID_PARENT: Task '${checkpoint.taskId}' does not exist`,
        "fail");
    }

    // Validate lane exists
    if (!validateEntityExists(database, "lanes", checkpoint.laneId)) {
      return generateReceipt("create", "checkpoint", id, false, undefined,
        `INVALID_PARENT: Lane '${checkpoint.laneId}' does not exist`,
        "fail");
    }

    // Validate mission exists
    if (!validateEntityExists(database, "missions", checkpoint.missionId)) {
      return generateReceipt("create", "checkpoint", id, false, undefined,
        `INVALID_PARENT: Mission '${checkpoint.missionId}' does not exist`,
        "fail");
    }

    // Verify task belongs to lane and mission
    const task = database.query("SELECT laneId, missionId FROM tasks WHERE id = ?").get(checkpoint.taskId) as { laneId: string; missionId: string } | null;
    if (task && (task.laneId !== checkpoint.laneId || task.missionId !== checkpoint.missionId)) {
      return generateReceipt("create", "checkpoint", id, false, undefined,
        `INVALID_LINEAGE: Task '${checkpoint.taskId}' belongs to lane '${task?.laneId}' and mission '${task?.missionId}'`,
        "fail");
    }

    // Get project and campaign for lineage
    const mission = database.query("SELECT campaignId FROM missions WHERE id = ?").get(checkpoint.missionId) as { campaignId: string } | null;
    const campaign = mission ? database.query("SELECT projectId FROM campaigns WHERE id = ?").get(mission.campaignId) as { projectId: string } | null : null;

    const stmt = database.prepare(`
      INSERT INTO checkpoints (id, type, taskId, laneId, missionId, projectId, campaignId, name, description, stateSnapshot, gitCommit, gitBranch, gitDirty, memoryBank, memoryQuery, memoryResults, memoryContextStatus, status, createdAt, updatedAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      checkpoint.type,
      checkpoint.taskId,
      checkpoint.laneId,
      checkpoint.missionId,
      campaign?.projectId || null,
      mission?.campaignId || null,
      checkpoint.name,
      checkpoint.description || "",
      JSON.stringify(checkpoint.stateSnapshot),
      checkpoint.gitCommit || null,
      checkpoint.gitBranch || null,
      checkpoint.gitDirty ? 1 : 0,
      checkpoint.memoryBank,
      checkpoint.memoryQuery || null,
      JSON.stringify(checkpoint.memoryResults || []),
      checkpoint.memoryContextStatus || "success",
      checkpoint.status,
      now,
      now,
      "system"
    );

    const created = database.query("SELECT * FROM checkpoints WHERE id = ?").get(id) as unknown as Checkpoint;
    return generateReceipt("create", "checkpoint", id, true, created, undefined, "pass");
  } catch (error) {
    return generateReceipt("create", "checkpoint", id, false, undefined, String(error), "fail");
  }
}

export function tribunusCheckpointGet(id: string, dbPath?: string): Checkpoint | null {
  const database = getDb(dbPath);
  const row = database.query("SELECT * FROM checkpoints WHERE id = ?").get(id) as unknown as Checkpoint | null;
  if (row) {
    row.stateSnapshot = JSON.parse(row.stateSnapshot as unknown as string);
    row.memoryResults = row.memoryResults ? JSON.parse(row.memoryResults as unknown as string) : undefined;
  }
  return row;
}

export function tribunusCheckpointList(
  taskId?: string,
  laneId?: string,
  missionId?: string,
  dbPath?: string
): Checkpoint[] {
  const database = getDb(dbPath);
  let rows: Checkpoint[];

  if (taskId && laneId && missionId) {
    rows = database.query("SELECT * FROM checkpoints WHERE taskId = ? AND laneId = ? AND missionId = ?")
      .all(taskId, laneId, missionId) as unknown as Checkpoint[];
  } else if (taskId) {
    rows = database.query("SELECT * FROM checkpoints WHERE taskId = ?").all(taskId) as unknown as Checkpoint[];
  } else if (laneId) {
    rows = database.query("SELECT * FROM checkpoints WHERE laneId = ?").all(laneId) as unknown as Checkpoint[];
  } else if (missionId) {
    rows = database.query("SELECT * FROM checkpoints WHERE missionId = ?").all(missionId) as unknown as Checkpoint[];
  } else {
    rows = database.query("SELECT * FROM checkpoints").all() as unknown as Checkpoint[];
  }

  return rows.map(row => ({
    ...row,
    stateSnapshot: JSON.parse(row.stateSnapshot as unknown as string),
    memoryResults: row.memoryResults ? JSON.parse(row.memoryResults as unknown as string) : undefined,
  }));
}

// ============================================================================
// RECEIPT CRUD
// ============================================================================

export function tribunusReceiptCreate(
  receipt: Omit<ReceiptType, "id" | "createdAt" | "updatedAt" | "createdBy">,
  dbPath?: string
): ReceiptType {
  const database = getDb(dbPath);
  const id = generateId();
  const now = new Date().toISOString();

  try {
    // Validate checkpointId if present
    if (receipt.checkpointId && !validateEntityExists(database, "checkpoints", receipt.checkpointId)) {
      return generateReceipt("create", "receipt", id, false, undefined,
        `INVALID_REFERENCE: Checkpoint '${receipt.checkpointId}' does not exist`,
        "fail");
    }

    const stmt = database.prepare(`
      INSERT INTO receipts (id, type, operation, entityType, entityId, previousState, nextState, success, error, verdict, startedAt, completedAt, durationMs, memoryBank, memoryOperationId, checkpointId, actor, source, payload, verifiedBy, verifiedAt, verificationHash, createdAt, updatedAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      receipt.type,
      receipt.operation,
      receipt.entityType,
      receipt.entityId,
      JSON.stringify(receipt.previousState),
      JSON.stringify(receipt.nextState),
      receipt.success ? 1 : 0,
      receipt.error || null,
      receipt.verdict || null,
      receipt.startedAt || now,
      receipt.completedAt || now,
      receipt.durationMs || null,
      receipt.memoryBank || null,
      receipt.memoryOperationId || null,
      receipt.checkpointId || null,
      receipt.actor || "system",
      receipt.source || "control-plane",
      JSON.stringify(receipt.payload),
      receipt.verifiedBy || null,
      receipt.verifiedAt || null,
      receipt.verificationHash || null,
      now,
      now,
      "system"
    );

    const created = database.query("SELECT * FROM receipts WHERE id = ?").get(id) as unknown as ReceiptType;
    if (created) {
      created.success = Boolean(created.success);
      created.previousState = created.previousState ? JSON.parse(created.previousState as unknown as string) : undefined;
      created.nextState = created.nextState ? JSON.parse(created.nextState as unknown as string) : undefined;
      created.payload = created.payload ? JSON.parse(created.payload as unknown as string) : undefined;
    }
    // Return the actual stored receipt, not a synthetic one.
    // The stored row carries the caller's verdict, actor, source, and error.
    const storedReceipt: ReceiptType = {
      ...(created || {} as unknown as ReceiptType),
      id: created?.id || id,
      operation: "create",
      entityType: "receipt",
      entityId: id,
      success: true, // the create operation succeeded
      verdict: created?.verdict || "pass",
      createdAt: created?.createdAt || now,
      updatedAt: created?.updatedAt || now,
      createdBy: created?.createdBy || "system",
      type: "receipt" as const,
      actor: created?.actor,
      source: created?.source,
      error: created?.error,
      checkpointId: created?.checkpointId,
    };
    return storedReceipt;
  } catch (error) {
    return generateReceipt("create", "receipt", id, false, undefined, String(error), "fail");
  }
}

export function tribunusReceiptGet(id: string, dbPath?: string): ReceiptType | null {
  const database = getDb(dbPath);
  const row = database.query("SELECT * FROM receipts WHERE id = ?").get(id) as unknown as ReceiptType | null;
  if (row) {
    row.success = Boolean(row.success);
    row.previousState = row.previousState ? JSON.parse(row.previousState as unknown as string) : undefined;
    row.nextState = row.nextState ? JSON.parse(row.nextState as unknown as string) : undefined;
    row.payload = row.payload ? JSON.parse(row.payload as unknown as string) : undefined;
  }
  return row;
}

export function tribunusReceiptList(
  entityType?: string,
  entityId?: string,
  dbPath?: string
): ReceiptType[] {
  const database = getDb(dbPath);
  let rows: ReceiptType[];

  if (entityType && entityId) {
    rows = database.query("SELECT * FROM receipts WHERE entityType = ? AND entityId = ?")
      .all(entityType, entityId) as unknown as ReceiptType[];
  } else if (entityType) {
    rows = database.query("SELECT * FROM receipts WHERE entityType = ?").all(entityType) as unknown as ReceiptType[];
  } else {
    rows = database.query("SELECT * FROM receipts").all() as unknown as ReceiptType[];
  }

  return rows.map(row => ({
    ...row,
    success: Boolean(row.success),
    previousState: row.previousState ? JSON.parse(row.previousState as unknown as string) : undefined,
    nextState: row.nextState ? JSON.parse(row.nextState as unknown as string) : undefined,
    payload: row.payload ? JSON.parse(row.payload as unknown as string) : undefined,
  }));
}

// ============================================================================
// MEMORY LINK CRUD
// ============================================================================

export function tribunusMemoryLinkCreate(
  link: Omit<MemoryLink, "id" | "createdAt" | "updatedAt" | "createdBy"> & { entityType: string; entityId: string },
  dbPath?: string
): ReceiptType {
  const database = getDb(dbPath);
  const id = generateId();
  const now = new Date().toISOString();

  try {
    // Validate entity exists
    if (!validateEntityExists(database, link.entityType + "s", link.entityId)) {
      return generateReceipt("create", "memory_link", id, false, undefined,
        `INVALID_ENTITY: ${link.entityType} '${link.entityId}' does not exist`,
        "fail");
    }

    // Check for duplicate link
    const existing = database.query(
      "SELECT id FROM memory_links WHERE entityType = ? AND entityId = ? AND memoryBank = ? AND memoryId = ?"
    ).get(link.entityType, link.entityId, link.memoryBank, link.memoryId);
    if (existing) {
      return generateReceipt("create", "memory_link", id, false, undefined,
        `DUPLICATE_LINK: Memory link already exists (${(existing as { id: string }).id})`,
        "fail");
    }

    const stmt = database.prepare(`
      INSERT INTO memory_links (id, type, entityType, entityId, memoryBank, memoryId, relationship, relevanceScore, notes, createdAt, updatedAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      link.type,
      link.entityType,
      link.entityId,
      link.memoryBank,
      link.memoryId,
      link.relationship,
      link.relevanceScore,
      link.notes || null,
      now,
      now,
      "system"
    );

    const created = database.query("SELECT * FROM memory_links WHERE id = ?").get(id) as MemoryLink;
    return generateReceipt("create", "memory_link", id, true, created, undefined, "pass");
  } catch (error) {
    return generateReceipt("create", "memory_link", id, false, undefined, String(error), "fail");
  }
}

export function tribunusMemoryLinkGet(id: string, dbPath?: string): MemoryLink | null {
  const database = getDb(dbPath);
  return database.query("SELECT * FROM memory_links WHERE id = ?").get(id) as MemoryLink | null;
}

export function tribunusMemoryLinkList(
  entityType?: string,
  entityId?: string,
  memoryBank?: string,
  dbPath?: string
): MemoryLink[] {
  const database = getDb(dbPath);
  let rows: MemoryLink[];

  if (entityType && entityId && memoryBank) {
    rows = database.query("SELECT * FROM memory_links WHERE entityType = ? AND entityId = ? AND memoryBank = ?")
      .all(entityType, entityId, memoryBank) as MemoryLink[];
  } else if (entityType && entityId) {
    rows = database.query("SELECT * FROM memory_links WHERE entityType = ? AND entityId = ?")
      .all(entityType, entityId) as MemoryLink[];
  } else if (memoryBank) {
    rows = database.query("SELECT * FROM memory_links WHERE memoryBank = ?").all(memoryBank) as MemoryLink[];
  } else {
    rows = database.query("SELECT * FROM memory_links").all() as MemoryLink[];
  }
  return rows;
}

// ============================================================================
// EVENT CRUD
// ============================================================================

export function tribunusEventCreate(
  event: Omit<Event, "id" | "createdAt" | "updatedAt" | "createdBy">,
  dbPath?: string
): ReceiptType {
  const database = getDb(dbPath);
  const id = generateId();
  const now = new Date().toISOString();

  try {
    const stmt = database.prepare(`
      INSERT INTO events (id, type, entityType, entityId, action, previousState, newState, changedFields, source, actor, ipAddress, userAgent, createdAt, updatedAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      event.type,
      event.entityType,
      event.entityId,
      event.action,
      JSON.stringify(event.previousState),
      JSON.stringify(event.newState),
      JSON.stringify(event.changedFields),
      event.source,
      event.actor || "system",
      event.ipAddress || null,
      event.userAgent || null,
      now,
      now,
      "system"
    );

    const created = database.query("SELECT * FROM events WHERE id = ?").get(id) as Event;
    return generateReceipt("create", "event", id, true, created, undefined, "pass");
  } catch (error) {
    return generateReceipt("create", "event", id, false, undefined, String(error), "fail");
  }
}

export function tribunusEventList(
  entityType?: string,
  entityId?: string,
  dbPath?: string
): Event[] {
  const database = getDb(dbPath);
  let rows: Event[];

  if (entityType && entityId) {
    rows = database.query("SELECT * FROM events WHERE entityType = ? AND entityId = ?")
      .all(entityType, entityId) as Event[];
  } else if (entityType) {
    rows = database.query("SELECT * FROM events WHERE entityType = ?").all(entityType) as Event[];
  } else {
    rows = database.query("SELECT * FROM events").all() as Event[];
  }

  return rows.map(row => ({
    ...row,
    previousState: row.previousState ? JSON.parse(row.previousState as unknown as string) : undefined,
    newState: row.newState ? JSON.parse(row.newState as unknown as string) : undefined,
    changedFields: row.changedFields ? JSON.parse(row.changedFields as unknown as string) : undefined,
  }));
}

// ============================================================================
// LANE CONFLICT CHECKING
// ============================================================================

/**
 * Check if two lanes have overlapping write paths
 * Conservative v1: exact match, parent/child, or broad wildcard overlap
 */
export function checkLaneConflict(lane1: Lane, lane2: Lane): boolean {
  // If either lane has no write paths, treat as conflicting with all write lanes
  if (!lane1.writePaths || lane1.writePaths.length === 0) {
    return !lane1.isReadOnly;
  }
  if (!lane2.writePaths || lane2.writePaths.length === 0) {
    return !lane2.isReadOnly;
  }

  // If either lane is read-only, no conflict
  if (lane1.isReadOnly || lane2.isReadOnly) {
    return false;
  }

  // Normalize paths
  const paths1 = lane1.writePaths.map(p => p.replace(/\/\//g, "/").replace(/\/$/, ""));
  const paths2 = lane2.writePaths.map(p => p.replace(/\/\//g, "/").replace(/\/$/, ""));

  // Check for exact overlap
  for (const p1 of paths1) {
    for (const p2 of paths2) {
      if (p1 === p2) {
        return true;
      }
      // Check parent/child relationship
      if (p1.startsWith(p2 + "/") || p2.startsWith(p1 + "/")) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a lane can be claimed (no active lease or lease expired)
 */
export function canClaimLane(lane: Lane, claimant: string): { claimable: boolean; reason: string } {
  if (!lane.currentLeaseHolder) {
    return { claimable: true, reason: "No current lease" };
  }

  if (lane.currentLeaseHolder === claimant) {
    return { claimable: true, reason: "Already held by claimant" };
  }

  if (lane.leaseExpiresAt) {
    const expiry = new Date(lane.leaseExpiresAt);
    const now = new Date();
    if (expiry <= now) {
      return { claimable: true, reason: "Lease expired" };
    }
    return { claimable: false, reason: `Lease held by ${lane.currentLeaseHolder} until ${lane.leaseExpiresAt}` };
  }

  return { claimable: false, reason: `Lease held by ${lane.currentLeaseHolder}` };
}

/**
 * Claim a lane lease
 */
export function claimLaneLease(
  laneId: string,
  claimant: string,
  durationMs: number = 3600000, // 1 hour default
  force: boolean = false,
  reason?: string,
  dbPath?: string
): ReceiptType {
  const database = getDb(dbPath);
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + durationMs).toISOString();

  const lane = tribunusLaneGet(laneId, dbPath);
  if (!lane) {
    return generateReceipt("claim_lease", "lane", laneId, false, undefined,
      `LANE_NOT_FOUND: Lane '${laneId}' does not exist`,
      "fail");
  }

  const claimCheck = canClaimLane(lane, claimant);
  if (!claimCheck.claimable && !force) {
    return generateReceipt("claim_lease", "lane", laneId, false, undefined,
      `CANNOT_CLAIM: ${claimCheck.reason}`,
      "fail");
  }

  try {
    const previousHolder = lane.currentLeaseHolder;
    const previousExpiry = lane.leaseAcquiredAt;

    const stmt = database.prepare(`
      UPDATE lanes SET currentLeaseHolder = ?, leaseAcquiredAt = ?, leaseExpiresAt = ?, updatedAt = ?
      WHERE id = ?
    `);
    stmt.run(claimant, now, expiry, now, laneId);

    const updated = database.query("SELECT * FROM lanes WHERE id = ?").get(laneId) as Lane;
    
    return generateReceipt("claim_lease", "lane", laneId, true, updated, undefined, 
      force ? "warning" : "pass");
  } catch (error) {
    return generateReceipt("claim_lease", "lane", laneId, false, undefined, String(error), "fail");
  }
}

/**
 * Release a lane lease
 */
export function releaseLaneLease(
  laneId: string,
  dbPath?: string
): ReceiptType {
  const database = getDb(dbPath);
  const now = new Date().toISOString();

  const lane = tribunusLaneGet(laneId, dbPath);
  if (!lane) {
    return generateReceipt("release_lease", "lane", laneId, false, undefined,
      `LANE_NOT_FOUND: Lane '${laneId}' does not exist`,
      "fail");
  }

  if (!lane.currentLeaseHolder) {
    return generateReceipt("release_lease", "lane", laneId, false, undefined,
      `NO_LEASE: Lane '${laneId}' has no active lease`,
      "fail");
  }

  try {
    const previousHolder = lane.currentLeaseHolder;
    const previousExpiry = lane.leaseExpiresAt;

    const stmt = database.prepare(`
      UPDATE lanes SET currentLeaseHolder = NULL, leaseAcquiredAt = NULL, leaseExpiresAt = NULL, updatedAt = ?
      WHERE id = ?
    `);
    stmt.run(now, laneId);

    const updated = database.query("SELECT * FROM lanes WHERE id = ?").get(laneId) as Lane;

    return generateReceipt("release_lease", "lane", laneId, true, updated, undefined, "pass");
  } catch (error) {
    return generateReceipt("release_lease", "lane", laneId, false, undefined, String(error), "fail");
  }
}

// ============================================================================
// TASK STATE TRANSITIONS
// ============================================================================

/**
 * Valid task state machine.
 * Each state -> set of allowed next states.
 * "pending" can go to "in_progress" or "skipped".
 * "in_progress" can go to "blocked", "completed", "failed", or "skipped".
 * "blocked" can go to "in_progress" (unblocked), "failed", or "skipped".
 * Terminal states ("completed", "failed", "skipped") cannot transition further.
 * Direct "pending" -> "completed" requires an explicit fast-complete receipt with evidence.
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["in_progress", "skipped", "completed"], // completed allowed only with fastComplete evidence
  in_progress: ["blocked", "completed", "failed", "skipped"],
  blocked: ["in_progress", "failed", "skipped"],
  completed: [],
  failed: [],
  skipped: [],
};

/**
 * Transition a task between states with validation and receipt emission.
 * Fails closed on invalid transitions.
 * Fast-complete (pending -> completed) requires explicit evidence.
 * blocked -> completed is never allowed without explicit unblock reason.
 */
export function tribunusTaskTransition(
  taskId: string,
  nextStatus: string,
  options: {
    actor?: string;
    reason?: string;
    evidence?: Record<string, unknown>;
    fastComplete?: boolean; // Required for pending -> completed
    dbPath?: string;
  } = {}
): ReceiptType {
  const database = getDb(options.dbPath);
  const now = new Date().toISOString();
  const actor = options.actor || "system";

  const task = database.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | null;
  if (!task) {
    return generateReceipt("transition", "task", taskId, false, undefined,
      `TASK_NOT_FOUND: Task '${taskId}' does not exist`,
      "fail");
  }

  const currentStatus = task.status;
  const allowed = VALID_TRANSITIONS[currentStatus];

  if (!allowed) {
    return generateReceipt("transition", "task", taskId, false, undefined,
      `UNKNOWN_STATE: Task '${taskId}' has unknown status '${currentStatus}'`,
      "fail");
  }

  if (!allowed.includes(nextStatus)) {
    return generateReceipt("transition", "task", taskId, false, undefined,
      `INVALID_TRANSITION: Cannot transition from '${currentStatus}' to '${nextStatus}'. Allowed: ${allowed.join(", ")}`,
      "fail");
  }

  // Fast-complete gate: pending -> completed requires explicit fastComplete flag and evidence
  if (currentStatus === "pending" && nextStatus === "completed") {
    if (!options.fastComplete) {
      return generateReceipt("transition", "task", taskId, false, undefined,
        `FAST_COMPLETE_DENIED: pending -> completed requires fastComplete=true and evidence`,
        "fail");
    }
    if (!options.evidence || Object.keys(options.evidence).length === 0) {
      return generateReceipt("transition", "task", taskId, false, undefined,
        `FAST_COMPLETE_DENIED: pending -> completed requires non-empty evidence payload`,
        "fail");
    }
  }

  // Blocked gate: blocked -> anything requires unblock reason (unless going to failed/skipped)
  if (currentStatus === "blocked" && nextStatus !== "failed" && nextStatus !== "skipped") {
    if (!options.reason) {
      return generateReceipt("transition", "task", taskId, false, undefined,
        `UNBLOCK_REQUIRED: Transition from 'blocked' to '${nextStatus}' requires a reason`,
        "fail");
    }
  }

  try {
    const previousState: Record<string, unknown> = {
      status: currentStatus,
      completedAt: task.completedAt,
      startedAt: task.startedAt,
    };

    const updates: Record<string, unknown> = {
      status: nextStatus,
      updatedAt: now,
    };

    // Set timing fields based on transition
    if (nextStatus === "in_progress" && !task.startedAt) {
      updates.startedAt = now;
    }
    if (nextStatus === "completed" || nextStatus === "failed" || nextStatus === "skipped") {
      updates.completedAt = now;
    }
    if (nextStatus === "in_progress" && currentStatus === "blocked") {
      // Unblocking — cleared completedAt but not startedAt
      updates.completedAt = null;
    }

    // Apply reason as actualEffort note if provided
    if (options.reason) {
      updates.actualEffort = `${task.actualEffort || ""} [${now}] ${options.reason}`.trim();
    }

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(", ");
    const values = Object.values(updates);

    database.prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`).run(...(values as unknown as string[]), taskId);

    const updated = database.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task;

    const receipt = generateReceipt("transition", "task", taskId, true, updated, undefined,
      currentStatus === "pending" && nextStatus === "completed" ? "warning" : "pass");

    // Store transition metadata in payload
    receipt.previousState = previousState;
    receipt.nextState = { status: nextStatus };
    receipt.actor = actor;
    if (options.reason) receipt.payload = { reason: options.reason };
    if (options.evidence) receipt.payload = { ...(receipt.payload || {}), evidence: options.evidence };

    // Persist the receipt itself
    const receiptId = generateId();
    database.prepare(`
      INSERT INTO receipts (id, type, operation, entityType, entityId, previousState, nextState, success, error, verdict, actor, source, payload, createdAt, updatedAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptId,
      "receipt",
      "transition",
      "task",
      taskId,
      JSON.stringify(receipt.previousState),
      JSON.stringify(receipt.nextState),
      receipt.success ? 1 : 0,
      receipt.error || null,
      receipt.verdict || null,
      receipt.actor || actor,
      "control-plane",
      JSON.stringify(receipt.payload || {}),
      now,
      now,
      "system"
    );

    return receipt;
  } catch (error) {
    return generateReceipt("transition", "task", taskId, false, undefined, String(error), "fail");
  }
}
