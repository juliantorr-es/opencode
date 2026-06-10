/**
 * Tribunus Bootstrap Control Plane v1 Hardening Gate — Adversarial Tests
 *
 * Doctrine: no authority claim without observable backing.
 * Every test tries to BREAK a claim. The desired outcome is not "throws" —
 * it's "fails closed with a typed failure receipt or a typed error that
 * the caller cannot confuse with success."
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync, existsSync } from "node:fs";

import { ALL_SCHEMA, PRAGMA_FOREIGN_KEYS_ON } from "./schema";
import {
  tribunusProjectCreate,
  tribunusCampaignCreate,
  tribunusMissionCreate,
  tribunusLaneCreate,
  tribunusTaskCreate,
  tribunusCheckpointCreate,
  tribunusReceiptCreate,
  tribunusMemoryLinkCreate,
  tribunusTaskTransition,
  tribunusProjectGetBySlug,
  tribunusCampaignGetBySlug,
  claimLaneLease,
  releaseLaneLease,
  canClaimLane,
  checkLaneConflict,
  closeDb,
} from "./crud";
import type { Project, Campaign, Mission, Lane, Task, Checkpoint, MemoryLink } from "./schema";

// ============================================================================
// TEST HELPERS
// ============================================================================

const TEST_DB = "test-hardening.db";

function freshDb(): Database {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  const db = new Database(TEST_DB, { create: true });
  db.exec(PRAGMA_FOREIGN_KEYS_ON);
  for (const sql of ALL_SCHEMA) {
    db.exec(sql);
  }
  return db;
}

function cleanup() {
  try { closeDb(); } catch {}
  try { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); } catch {}
}

function makeId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function seedProject(db?: string): Project {
  const receipt = tribunusProjectCreate({
    type: "project",
    name: "Hardening Test",
    slug: `hardening-test-${makeId()}`,
    description: "Adversarial test project",
    version: "0.1.0",
    status: "active",
  }, db);
  if (!receipt.success) throw new Error(`Seed project failed: ${receipt.error}`);
  return receipt.output as unknown as Project;
}

function seedCampaign(projectId: string, db?: string): Campaign {
  const receipt = tribunusCampaignCreate({
    type: "campaign",
    projectId,
    name: "Hardening Campaign",
    slug: `hardening-campaign-${makeId()}`,
    description: "Test campaign",
    objective: "Prove primitives cannot lie",
    status: "not_started",
    memoryBank: "tribunus-core",
  }, db);
  if (!receipt.success) throw new Error(`Seed campaign failed: ${receipt.error}`);
  return receipt.output as unknown as Campaign;
}

function seedMission(campaignId: string, db?: string): Mission {
  const receipt = tribunusMissionCreate({
    type: "mission",
    campaignId,
    name: "Hardening Mission",
    slug: `hardening-mission-${makeId()}`,
    description: "Test mission",
    purpose: "Adversarial testing",
    status: "not_started",
    priority: 100,
    acceptanceCriteria: ["Pass hardening gate"],
    memoryBank: "tribunus-core",
  }, db);
  if (!receipt.success) throw new Error(`Seed mission failed: ${receipt.error}`);
  return receipt.output as unknown as Mission;
}

function seedLane(missionId: string, opts?: { isReadOnly?: boolean; writePaths?: string[]; slug?: string }, db?: string): Lane {
  const receipt = tribunusLaneCreate({
    type: "lane",
    missionId,
    name: `Hardening Lane ${opts?.slug || makeId()}`,
    slug: opts?.slug || `hardening-lane-${makeId()}`,
    description: "Test lane",
    scope: opts?.slug || "test-scope",
    status: "idle",
    isReadOnly: opts?.isReadOnly ?? false,
    writePaths: opts?.writePaths ?? ["/test/hardening"],
  }, db);
  if (!receipt.success) throw new Error(`Seed lane failed: ${receipt.error}`);
  return receipt.output as unknown as Lane;
}

function seedTask(laneId: string, missionId: string, opts?: { slug?: string }, db?: string): Task {
  const receipt = tribunusTaskCreate({
    type: "task",
    laneId,
    missionId,
    name: `Hardening Task ${opts?.slug || makeId()}`,
    slug: opts?.slug || `hardening-task-${makeId()}`,
    description: "Test task",
    status: "pending",
    priority: 50,
    dependsOn: [],
    blocks: [],
  }, db);
  if (!receipt.success) throw new Error(`Seed task failed: ${receipt.error}`);
  return receipt.output as unknown as Task;
}

// ============================================================================
// DOMAIN 1: Relational Integrity — FK Constraints & Orphan Prevention
// ============================================================================

describe("Domain 1: Relational Integrity", () => {
  beforeAll(() => freshDb());
  afterAll(() => cleanup());

  test("foreign keys are enabled per connection", () => {
    const db = new Database(TEST_DB, { create: true });
    db.exec(PRAGMA_FOREIGN_KEYS_ON);
    const result = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(result.foreign_keys).toBe(1);
  });

  test("campaign create fails with nonexistent project", () => {
    const receipt = tribunusCampaignCreate({
      type: "campaign",
      projectId: "nonexistent-project-id",
      name: "Orphan Campaign",
      slug: `orphan-${makeId()}`,
      description: "Should fail",
      objective: "Test FK",
      status: "not_started",
      memoryBank: "tribunus-core",
    }, TEST_DB);
    expect(receipt.success).toBe(false);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.error).toContain("INVALID_PARENT");
  });

  test("mission create fails with nonexistent campaign", () => {
    const receipt = tribunusMissionCreate({
      type: "mission",
      campaignId: "nonexistent-campaign-id",
      name: "Orphan Mission",
      slug: `orphan-${makeId()}`,
      description: "Should fail",
      purpose: "Test FK",
      status: "not_started",
      priority: 50,
      acceptanceCriteria: [],
      memoryBank: "tribunus-core",
    }, TEST_DB);
    expect(receipt.success).toBe(false);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.error).toContain("INVALID_PARENT");
  });

  test("lane create fails with nonexistent mission", () => {
    const receipt = tribunusLaneCreate({
      type: "lane",
      missionId: "nonexistent-mission-id",
      name: "Orphan Lane",
      slug: `orphan-${makeId()}`,
      description: "Should fail",
      scope: "test",
      status: "idle",
      writePaths: ["/test"],
    } as any, TEST_DB)
    expect(receipt.success).toBe(false);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.error).toContain("INVALID_PARENT");
  });

  test("task create fails with nonexistent mission", () => {
    const lane = seedLane(seedMission(seedCampaign(seedProject(TEST_DB).id, TEST_DB).id, TEST_DB).id, {}, TEST_DB);
    const receipt = tribunusTaskCreate({
      type: "task",
      laneId: lane.id,
      missionId: "nonexistent-mission-id",
      name: "Orphan Task",
      slug: `orphan-${makeId()}`,
      description: "Should fail",
      status: "pending",
      priority: 50,
      dependsOn: [],
      blocks: [],
    }, TEST_DB);
    expect(receipt.success).toBe(false);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.error).toContain("INVALID_PARENT");
  });

  test("task create fails with nonexistent lane", () => {
    const mission = seedMission(seedCampaign(seedProject(TEST_DB).id, TEST_DB).id, TEST_DB);
    const receipt = tribunusTaskCreate({
      type: "task",
      laneId: "nonexistent-lane-id",
      missionId: mission.id,
      name: "Orphan Task",
      slug: `orphan-${makeId()}`,
      description: "Should fail",
      status: "pending",
      priority: 50,
      dependsOn: [],
      blocks: [],
    }, TEST_DB);
    expect(receipt.success).toBe(false);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.error).toContain("INVALID_PARENT");
  });

  test("task create fails when lane does not belong to mission", () => {
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission1 = seedMission(campaign.id, TEST_DB);
    const mission2 = seedMission(campaign.id, TEST_DB);
    const lane = seedLane(mission1.id, {}, TEST_DB);
    // Try to create task in mission2 but reference lane from mission1
    const receipt = tribunusTaskCreate({
      type: "task",
      laneId: lane.id,
      missionId: mission2.id,
      name: "Lineage Break Task",
      slug: `lineage-break-${makeId()}`,
      description: "Should fail",
      status: "pending",
      priority: 50,
      dependsOn: [],
      blocks: [],
    }, TEST_DB);
    expect(receipt.success).toBe(false);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.error).toContain("INVALID_LINEAGE");
  });

  test("checkpoint create fails with nonexistent task", () => {
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission = seedMission(campaign.id, TEST_DB);
    const lane = seedLane(mission.id, {}, TEST_DB);
    const receipt = tribunusCheckpointCreate({
      type: "checkpoint",
      taskId: "nonexistent-task-id",
      laneId: lane.id,
      missionId: mission.id,
      name: "Orphan Checkpoint",
      description: "Should fail",
      stateSnapshot: {},
      memoryBank: "tribunus-core",
      status: "created",
    }, TEST_DB);
    expect(receipt.success).toBe(false);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.error).toContain("INVALID_PARENT");
  });

  test("receipt create fails with nonexistent checkpoint reference", () => {
    const receipt = tribunusReceiptCreate({
      type: "receipt",
      operation: "test",
      entityType: "checkpoint",
      entityId: "nonexistent-id",
      checkpointId: "nonexistent-checkpoint-id",
      success: true,
    }, TEST_DB);
    expect(receipt.success).toBe(false);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.error).toContain("INVALID_REFERENCE");
  });

  test("memory link create fails with nonexistent entity", () => {
    const receipt = tribunusMemoryLinkCreate({
      type: "memory_link",
      entityType: "task",
      entityId: "nonexistent-task-id",
      memoryBank: "tribunus-core",
      memoryId: "mem-123",
      relationship: "context",
      relevanceScore: 0.5,
    }, TEST_DB);
    expect(receipt.success).toBe(false);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.error).toContain("INVALID_ENTITY");
  });

  test("duplicate campaign slug within same project fails", () => {
    const project = seedProject(TEST_DB);
    const slug = `dup-slug-${makeId()}`;
    const r1 = tribunusCampaignCreate({
      type: "campaign", projectId: project.id, name: "First", slug,
      description: "", objective: "", status: "not_started", memoryBank: "tribunus-core",
    }, TEST_DB);
    expect(r1.success).toBe(true);
    const r2 = tribunusCampaignCreate({
      type: "campaign", projectId: project.id, name: "Second", slug,
      description: "", objective: "", status: "not_started", memoryBank: "tribunus-core",
    }, TEST_DB);
    expect(r2.success).toBe(false);
    expect(r2.error).toContain("DUPLICATE_SLUG");
  });

  test("duplicate mission slug within same campaign fails", () => {
    const campaign = seedCampaign(seedProject(TEST_DB).id, TEST_DB);
    const slug = `dup-msn-${makeId()}`;
    const r1 = tribunusMissionCreate({
      type: "mission", campaignId: campaign.id, name: "First", slug,
      description: "", purpose: "", status: "not_started", priority: 50,
      acceptanceCriteria: [], memoryBank: "tribunus-core",
    }, TEST_DB);
    expect(r1.success).toBe(true);
    const r2 = tribunusMissionCreate({
      type: "mission", campaignId: campaign.id, name: "Second", slug,
      description: "", purpose: "", status: "not_started", priority: 50,
      acceptanceCriteria: [], memoryBank: "tribunus-core",
    }, TEST_DB);
    expect(r2.success).toBe(false);
    expect(r2.error).toContain("DUPLICATE_SLUG");
  });
});

// ============================================================================
// DOMAIN 2: Init Idempotency
// ============================================================================

describe("Domain 2: Init Idempotency", () => {
  beforeAll(() => freshDb());
  afterAll(() => cleanup());

  test("running init twice does not duplicate seed entities", () => {
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission = seedMission(campaign.id, TEST_DB);
    const lane = seedLane(mission.id, {}, TEST_DB);
    const task = seedTask(lane.id, mission.id, {}, TEST_DB);

    // Verify entities exist
    expect(project.id).toBeTruthy();
    expect(campaign.id).toBeTruthy();
    expect(mission.id).toBeTruthy();
    expect(lane.id).toBeTruthy();
    expect(task.id).toBeTruthy();

    // Attempt to recreate same slugs — should fail, not duplicate
    const rp2 = tribunusProjectCreate({
      type: "project", name: "Dup", slug: project.slug,
      description: "", version: "0.1.0", status: "active",
    }, TEST_DB);
    expect(rp2.success).toBe(false);
    expect(rp2.error).toContain("DUPLICATE_SLUG");

    const rc2 = tribunusCampaignCreate({
      type: "campaign", projectId: project.id, name: "Dup", slug: campaign.slug,
      description: "", objective: "", status: "not_started", memoryBank: "tribunus-core",
    }, TEST_DB);
    expect(rc2.success).toBe(false);
    expect(rc2.error).toContain("DUPLICATE_SLUG");

    // Count: should still be exactly 1 each
    const db = new Database(TEST_DB, { create: true });
    const projectCount = db.query("SELECT count(*) as c FROM projects WHERE slug = ?").get(project.slug) as { c: number };
    expect(projectCount.c).toBe(1);
    const campaignCount = db.query("SELECT count(*) as c FROM campaigns WHERE slug = ?").get(campaign.slug) as { c: number };
    expect(campaignCount.c).toBe(1);
  });
});

// ============================================================================
// DOMAIN 3: Lane Lease & Conflict Hardening
// ============================================================================

describe("Domain 3: Lane Lease & Conflict Hardening", () => {
  let mission: Mission;
  let lane1: Lane;
  let lane2: Lane;

  beforeAll(() => {
    freshDb();
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    mission = seedMission(campaign.id, TEST_DB);
    lane1 = seedLane(mission.id, { slug: "scope-alpha", writePaths: ["/packages/opencode/src/tribunus"] }, TEST_DB);
    lane2 = seedLane(mission.id, { slug: "scope-beta", writePaths: ["/packages/opencode/src/tribunus/control-plane"] }, TEST_DB);
  });
  afterAll(() => cleanup());

  test("overlapping write paths detect conflict (parent/child)", () => {
    const conflict = checkLaneConflict(lane1, lane2);
    expect(conflict).toBe(true);
  });

  test("disjoint write paths do not conflict", () => {
    const laneA = seedLane(mission.id, { slug: "disjoint-a", writePaths: ["/packages/app"] }, TEST_DB);
    const laneB = seedLane(mission.id, { slug: "disjoint-b", writePaths: ["/packages/desktop"] }, TEST_DB);
    const conflict = checkLaneConflict(laneA, laneB);
    expect(conflict).toBe(false);
  });

  test("read-only lane does not conflict with write lane", () => {
    const readLane = seedLane(mission.id, { slug: "read-only-lane", isReadOnly: true, writePaths: ["/packages/opencode"] }, TEST_DB);
    const writeLane = seedLane(mission.id, { slug: "write-lane", writePaths: ["/packages/opencode"] }, TEST_DB);
    const conflict = checkLaneConflict(readLane, writeLane);
    expect(conflict).toBe(false);
  });

  test("lane with no write paths treated as conflicting unless read-only", () => {
    const noPathLane = seedLane(mission.id, { slug: "no-path-lane", writePaths: [] }, TEST_DB);
    const otherLane = seedLane(mission.id, { slug: "other-lane", writePaths: ["/docs"] }, TEST_DB);
    const conflict = checkLaneConflict(noPathLane, otherLane);
    expect(conflict).toBe(true);
  });

  test("can claim unclaimed lane", () => {
    const freshLane = seedLane(mission.id, { slug: "fresh-claim" }, TEST_DB);
    const result = canClaimLane(freshLane, "agent-alpha");
    expect(result.claimable).toBe(true);
  });

  test("claiming lane sets lease", () => {
    const freshLane = seedLane(mission.id, { slug: "lease-claim-test" }, TEST_DB);
    const receipt = claimLaneLease(freshLane.id, "agent-alpha", 3600000, false, undefined, TEST_DB);
    expect(receipt.success).toBe(true);
    expect(receipt.verdict).toBe("pass");
  });

  test("cannot claim lane held by another claimant (non-expired)", () => {
    const freshLane = seedLane(mission.id, { slug: "held-lane" }, TEST_DB);
    const claim1 = claimLaneLease(freshLane.id, "agent-alpha", 3600000, false, undefined, TEST_DB);
    expect(claim1.success).toBe(true);

    const claim2 = claimLaneLease(freshLane.id, "agent-beta", 3600000, false, undefined, TEST_DB);
    expect(claim2.success).toBe(false);
    expect(claim2.error).toContain("CANNOT_CLAIM");
  });

  test("can force-claim lane held by another claimant", () => {
    const freshLane = seedLane(mission.id, { slug: "force-lane" }, TEST_DB);
    claimLaneLease(freshLane.id, "agent-alpha", 3600000, false, undefined, TEST_DB);

    const forceReceipt = claimLaneLease(freshLane.id, "agent-beta", 3600000, true, "Escalation: agent-alpha unresponsive", TEST_DB);
    expect(forceReceipt.success).toBe(true);
    expect(forceReceipt.verdict).toBe("warning"); // Force claim must produce warning
  });

  test("can reclaim expired lease", () => {
    const freshLane = seedLane(mission.id, { slug: "expiring-lane" }, TEST_DB);
    // Claim with 0ms duration = immediately expired
    claimLaneLease(freshLane.id, "agent-alpha", 0, false, undefined, TEST_DB);

    const reclaim = claimLaneLease(freshLane.id, "agent-beta", 3600000, false, undefined, TEST_DB);
    expect(reclaim.success).toBe(true);
  });

  test("lease release clears holder", () => {
    const freshLane = seedLane(mission.id, { slug: "release-lane" }, TEST_DB);
    claimLaneLease(freshLane.id, "agent-alpha", 3600000, false, undefined, TEST_DB);

    const release = releaseLaneLease(freshLane.id, TEST_DB);
    expect(release.success).toBe(true);

    // Lane should now be claimable
    const check = canClaimLane(freshLane, "agent-beta");
    expect(check.claimable).toBe(true);
  });

  test("releasing unclaimed lane fails", () => {
    const freshLane = seedLane(mission.id, { slug: "no-lease-lane" }, TEST_DB);
    const release = releaseLaneLease(freshLane.id, TEST_DB);
    expect(release.success).toBe(false);
    expect(release.error).toContain("NO_LEASE");
  });
});

// ============================================================================
// DOMAIN 4: Task State Transitions
// ============================================================================

describe("Domain 4: Task State Transitions", () => {
  let task: Task;

  beforeAll(() => {
    freshDb();
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission = seedMission(campaign.id, TEST_DB);
    const lane = seedLane(mission.id, {}, TEST_DB);
    task = seedTask(lane.id, mission.id, {}, TEST_DB);
  });
  afterAll(() => cleanup());

  test("valid transition: pending -> in_progress", () => {
    const r = tribunusTaskTransition(task.id, "in_progress", { actor: "test", dbPath: TEST_DB });
    expect(r.success).toBe(true);
    expect(r.verdict).toBe("pass");
  });

  test("valid transition: in_progress -> blocked", () => {
    const r = tribunusTaskTransition(task.id, "blocked", { actor: "test", reason: "dependency", dbPath: TEST_DB });
    expect(r.success).toBe(true);
  });

  test("valid transition: blocked -> in_progress (unblock)", () => {
    const r = tribunusTaskTransition(task.id, "in_progress", { actor: "test", reason: "dependency resolved", dbPath: TEST_DB });
    expect(r.success).toBe(true);
  });

  test("valid transition: in_progress -> completed", () => {
    const r = tribunusTaskTransition(task.id, "completed", { actor: "test", reason: "work done", dbPath: TEST_DB });
    expect(r.success).toBe(true);
    expect(r.verdict).toBe("pass");
  });

  test("terminal state rejects further transitions", () => {
    const r = tribunusTaskTransition(task.id, "in_progress", { actor: "test", dbPath: TEST_DB });
    expect(r.success).toBe(false);
    expect(r.error).toContain("INVALID_TRANSITION");
  });

  test("blocked -> completed is not a valid transition", () => {
    // Fresh task for this test
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission = seedMission(campaign.id, TEST_DB);
    const lane = seedLane(mission.id, {}, TEST_DB);
    const t = seedTask(lane.id, mission.id, {}, TEST_DB);

    tribunusTaskTransition(t.id, "in_progress", { dbPath: TEST_DB });
    tribunusTaskTransition(t.id, "blocked", { reason: "test block", dbPath: TEST_DB });

    // blocked -> completed should fail without reason
    const r = tribunusTaskTransition(t.id, "completed", { actor: "test", dbPath: TEST_DB });
    expect(r.success).toBe(false);
    expect(r.error).toContain("INVALID_TRANSITION");
  });

  test("blocked -> failed does not require unblock reason", () => {
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission = seedMission(campaign.id, TEST_DB);
    const lane = seedLane(mission.id, {}, TEST_DB);
    const t = seedTask(lane.id, mission.id, {}, TEST_DB);

    tribunusTaskTransition(t.id, "in_progress", { dbPath: TEST_DB });
    tribunusTaskTransition(t.id, "blocked", { reason: "test", dbPath: TEST_DB });

    const r = tribunusTaskTransition(t.id, "failed", { dbPath: TEST_DB });
    expect(r.success).toBe(true);
  });

  test("pending -> completed without fastComplete fails", () => {
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission = seedMission(campaign.id, TEST_DB);
    const lane = seedLane(mission.id, {}, TEST_DB);
    const t = seedTask(lane.id, mission.id, {}, TEST_DB);

    const r = tribunusTaskTransition(t.id, "completed", { dbPath: TEST_DB });
    expect(r.success).toBe(false);
    expect(r.error).toContain("FAST_COMPLETE_DENIED");
  });

  test("pending -> completed with fastComplete and evidence succeeds (warning verdict)", () => {
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission = seedMission(campaign.id, TEST_DB);
    const lane = seedLane(mission.id, {}, TEST_DB);
    const t = seedTask(lane.id, mission.id, {}, TEST_DB);

    const r = tribunusTaskTransition(t.id, "completed", {
      actor: "test",
      fastComplete: true,
      evidence: { tested: true, reason: "trivial task" },
      dbPath: TEST_DB,
    });
    expect(r.success).toBe(true);
    expect(r.verdict).toBe("warning"); // Fast-complete must carry warning
  });

  test("transition emits receipt with previous/next state", () => {
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission = seedMission(campaign.id, TEST_DB);
    const lane = seedLane(mission.id, {}, TEST_DB);
    const t = seedTask(lane.id, mission.id, {}, TEST_DB);

    const r = tribunusTaskTransition(t.id, "in_progress", { actor: "test-agent", dbPath: TEST_DB });
    expect(r.success).toBe(true);
    expect(r.previousState).toBeDefined();
    expect((r.previousState as Record<string, unknown>).status).toBe("pending");
    expect(r.nextState).toBeDefined();
    expect((r.nextState as Record<string, unknown>).status).toBe("in_progress");
    expect(r.actor).toBe("test-agent");
  });
});

// ============================================================================
// DOMAIN 5: Checkpoint Lineage Validation
// ============================================================================

describe("Domain 5: Checkpoint Lineage Validation", () => {
  beforeAll(() => freshDb());
  afterAll(() => cleanup());

  test("checkpoint requires valid task", () => {
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission = seedMission(campaign.id, TEST_DB);
    const lane = seedLane(mission.id, {}, TEST_DB);

    const receipt = tribunusCheckpointCreate({
      type: "checkpoint",
      taskId: "nonexistent-task",
      laneId: lane.id,
      missionId: mission.id,
      name: "Bad Lineage",
      description: "Should fail",
      stateSnapshot: {},
      memoryBank: "tribunus-core",
      status: "created",
    }, TEST_DB);
    expect(receipt.success).toBe(false);
  });

  test("checkpoint validates task-lane-mission lineage", () => {
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission1 = seedMission(campaign.id, TEST_DB);
    const mission2 = seedMission(campaign.id, TEST_DB);
    const lane1 = seedLane(mission1.id, {}, TEST_DB);
    const task1 = seedTask(lane1.id, mission1.id, {}, TEST_DB);

    // Try to create checkpoint referencing task from mission1 but lane from mission2
    const lane2 = seedLane(mission2.id, {}, TEST_DB);
    const receipt = tribunusCheckpointCreate({
      type: "checkpoint",
      taskId: task1.id,
      laneId: lane2.id, // Wrong lane — task belongs to lane1
      missionId: mission1.id,
      name: "Lineage Mismatch",
      description: "Should fail",
      stateSnapshot: {},
      memoryBank: "tribunus-core",
      status: "created",
    }, TEST_DB);
    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain("INVALID_LINEAGE");
  });

  test("checkpoint captures project and campaign lineage", () => {
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const mission = seedMission(campaign.id, TEST_DB);
    const lane = seedLane(mission.id, {}, TEST_DB);
    const task = seedTask(lane.id, mission.id, {}, TEST_DB);

    const receipt = tribunusCheckpointCreate({
      type: "checkpoint",
      taskId: task.id,
      laneId: lane.id,
      missionId: mission.id,
      name: "Lineage Checkpoint",
      description: "Has full lineage",
      stateSnapshot: { test: true },
      memoryBank: "tribunus-core",
      status: "created",
    }, TEST_DB);

    if (!receipt.success) console.log("CHECKPOINT ERROR:", receipt.error);
    expect(receipt.success).toBe(true);
    const checkpoint = receipt.output as unknown as Checkpoint;
    expect(checkpoint.projectId).toBe(project.id);
    expect(checkpoint.campaignId).toBe(campaign.id);
    expect(checkpoint.memoryContextStatus).toBe("success");
  });
});

// ============================================================================
// DOMAIN 6: Receipt Completeness
// ============================================================================

describe("Domain 6: Receipt Completeness", () => {
  beforeAll(() => freshDb());
  afterAll(() => cleanup());

  test("create receipt has required fields", () => {
    const project = seedProject(TEST_DB);
    const campaign = seedCampaign(project.id, TEST_DB);
    const receipt = tribunusReceiptCreate({
      type: "receipt",
      operation: "test_create",
      entityType: "campaign",
      entityId: campaign.id,
      success: true,
      verdict: "pass",
      actor: "test-runner",
      source: "hardening-tests",
    }, TEST_DB);

    expect(receipt.success).toBe(true);
    expect(receipt.verdict).toBe("pass");
    expect(receipt.actor === "test-runner" || receipt.actor === "system").toBe(true);
    expect(receipt.source).toBe("hardening-tests");
  });

  test("receipt that says pass has no error", () => {
    const project = seedProject(TEST_DB);
    const receipt = tribunusReceiptCreate({
      type: "receipt",
      operation: "pass_test",
      entityType: "project",
      entityId: project.id,
      success: true,
      verdict: "pass",
    }, TEST_DB);
    expect(receipt.success).toBe(true);
    expect(receipt.error ?? undefined).toBeUndefined();
  });

  test("receipt that says fail has error", () => {
    const receipt = tribunusReceiptCreate({
      type: "receipt",
      operation: "fail_test",
      entityType: "unknown",
      entityId: "none",
      success: false,
      error: "Simulated failure",
      verdict: "fail",
    }, TEST_DB);
    expect(receipt.success).toBe(true);
    expect(receipt.error).toBe("Simulated failure");
    expect(receipt.verdict).toBe("fail");
  });

  test("receipt that says warning explains degraded behavior", () => {
    const receipt = tribunusReceiptCreate({
      type: "receipt",
      operation: "warning_test",
      entityType: "system",
      entityId: "test",
      success: true,
      error: "Git state unavailable: using partial checkpoint",
      verdict: "warning",
    }, TEST_DB);
    expect(receipt.success).toBe(true);
  });
});

// ============================================================================
// DOMAIN 7: Memory Link Integrity
// ============================================================================

describe("Domain 7: Memory Link Integrity", () => {
  beforeAll(() => freshDb());
  afterAll(() => cleanup());

  test("memory link to existing entity succeeds", () => {
    const project = seedProject(TEST_DB);
    const receipt = tribunusMemoryLinkCreate({
      type: "memory_link",
      entityType: "project",
      entityId: project.id,
      memoryBank: "tribunus-core",
      memoryId: "mem-test-1",
      relationship: "context",
      relevanceScore: 0.8,
    }, TEST_DB);
    expect(receipt.success).toBe(true);
  });

  test("memory link to nonexistent entity fails", () => {
    const receipt = tribunusMemoryLinkCreate({
      type: "memory_link",
      entityType: "project",
      entityId: "no-such-project",
      memoryBank: "tribunus-core",
      memoryId: "mem-orphan",
      relationship: "context",
      relevanceScore: 0.5,
    }, TEST_DB);
    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain("INVALID_ENTITY");
  });

  test("duplicate memory link (same entity+bank+memId) fails", () => {
    const project = seedProject(TEST_DB);
    const link = {
      type: "memory_link" as const,
      entityType: "project",
      entityId: project.id,
      memoryBank: "tribunus-core",
      memoryId: "mem-dup-test",
      relationship: "context" as const,
      relevanceScore: 0.5,
    };

    const r1 = tribunusMemoryLinkCreate(link, TEST_DB);
    expect(r1.success).toBe(true);

    const r2 = tribunusMemoryLinkCreate(link, TEST_DB);
    expect(r2.success).toBe(false);
    expect(r2.error).toContain("DUPLICATE_LINK");
  });

  test("memory link validates entityType table suffix", () => {
    const project = seedProject(TEST_DB);
    // "project" becomes "projects" table lookup — should succeed
    const r1 = tribunusMemoryLinkCreate({
      type: "memory_link",
      entityType: "project",
      entityId: project.id,
      memoryBank: "tribunus-core",
      memoryId: "mem-valid-type",
      relationship: "context",
      relevanceScore: 0.5,
    }, TEST_DB);
    expect(r1.success).toBe(true);

    // "nonexistent_type" becomes "nonexistent_types" table — should fail
    const r2 = tribunusMemoryLinkCreate({
      type: "memory_link",
      entityType: "nonexistent",
      entityId: project.id,
      memoryBank: "tribunus-core",
      memoryId: "mem-bad-type",
      relationship: "context",
      relevanceScore: 0.5,
    }, TEST_DB);
    expect(r2.success).toBe(false);
  });
});
