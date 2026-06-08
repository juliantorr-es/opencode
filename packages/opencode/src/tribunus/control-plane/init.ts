/**
 * Tribunus Control Plane Initialization
 * Creates the initial project, campaign, missions, lanes, and tasks
 * for the Authority Binding and Kernel Completion campaign.
 * 
 * Hardening: Idempotent - safe to run multiple times without duplicating seed entities.
 */

import {
  tribunusProjectCreate,
  tribunusCampaignCreate,
  tribunusMissionCreate,
  tribunusLaneCreate,
  tribunusTaskCreate,
  closeDb,
  tribunusProjectGetBySlug,
  tribunusCampaignGetBySlug,
  tribunusMissionGetBySlug,
  tribunusLaneGetBySlug,
  tribunusTaskGetBySlug,
} from "./crud";
import type { Project, Campaign, Mission, Lane, Task } from "./schema";

const DB_PATH = "tribunus-control-plane.db";

interface InitResult {
  project: { created: boolean; id: string; existingId?: string };
  campaign: { created: boolean; id: string; existingId?: string };
  missions: Array<{ created: boolean; id: string; name: string; existingId?: string }>;
  lanes: Array<{ created: boolean; id: string; name: string; existingId?: string }>;
  tasks: Array<{ created: boolean; id: string; name: string; existingId?: string }>;
  summary: {
    totalCreated: number;
    totalExisting: number;
    totalSkipped: number;
  };
}

// ============================================================================
// SEED ENTITIES
// ============================================================================

const PROJECT_SLUG = "tribunus";

const PROJECT: Omit<Project, "id" | "createdAt" | "updatedAt" | "createdBy"> & { slug: string } = {
  type: "project",
  name: "Tribunus",
  slug: PROJECT_SLUG,
  description: "The governed agent execution platform",
  version: "0.1.0",
  status: "active",
};

const CAMPAIGN_SLUG = "authority-binding-kernel-completion";

const CAMPAIGN: Omit<Campaign, "id" | "createdAt" | "updatedAt" | "createdBy"> & { slug: string; projectId: string } = {
  type: "campaign",
  projectId: "", // Will be set after project creation
  name: "Authority Binding and Kernel Completion",
  slug: CAMPAIGN_SLUG,
  description: "Complete the Valkey Stream-Backed Coordination Kernel implementation and establish authority binding contracts",
  objective: "Gate completes the Valkey Stream-Backed Coordination Kernel implementation in the strong sense",
  status: "in_progress",
  startDate: new Date().toISOString(),
  memoryBank: "tribunus-core",
};

const MISSIONS: Array<Omit<Mission, "id" | "createdAt" | "updatedAt" | "createdBy"> & { slug: string; campaignId: string }> = [
  {
    type: "mission",
    campaignId: "", // Will be set
    name: "Valkey Stream-Backed Coordination Kernel",
    slug: "valkey-coordination-kernel",
    description: "Complete the coordination kernel with proper Valkey stream bindings",
    purpose: "Bind work queue abstraction to actual Valkey streams with lease semantics",
    status: "in_progress",
    priority: 100,
    acceptanceCriteria: [
      "Work queue bound to Valkey streams",
      "Each lane has dedicated stream with consumer group",
      "Single-writer-per-scope lease semantics implemented",
      "Recovery module handles stream failures",
      "Scheduler respects lane leases",
      "Observability captures stream metrics",
    ],
    memoryBank: "tribunus-runtime",
  },
  {
    type: "mission",
    campaignId: "",
    name: "Authority Binding Contracts",
    slug: "authority-binding-contracts",
    description: "Establish explicit authority binding between PGlite, Valkey, Mnemopi, Dharma, and Oh My Pi",
    purpose: "No hidden authority transitions - all claims must be explicit and traceable",
    status: "not_started",
    priority: 90,
    acceptanceCriteria: [
      "PGlite owns durable authority (exclusive)",
      "Valkey owns coordination (non-durable)",
      "Mnemopi owns semantic continuity (non-authoritative)",
      "Dharma governs trust and reputation",
      "Oh My Pi owns agent execution loop",
      "All authority transitions require explicit delegation",
    ],
    memoryBank: "tribunus-core",
  },
  {
    type: "mission",
    campaignId: "",
    name: "Tribunus SDK Extension Store",
    slug: "sdk-extension-store",
    description: "Build extension-store with authority-manifest direction",
    purpose: "Extensions require authority manifests declaring capabilities, permissions, and memory access scopes",
    status: "not_started",
    priority: 80,
    acceptanceCriteria: [
      "Extension authority-manifest.json schema defined",
      "Extensions declare durable state access",
      "Extensions declare coordination primitive usage",
      "Extensions declare memory bank access",
      "Extension loading validates manifest",
      "Malicious extension assumptions baked in",
    ],
    memoryBank: "tribunus-sdk",
  },
  {
    type: "mission",
    campaignId: "",
    name: "Security Sandboxing",
    slug: "security-sandboxing",
    description: "Implement sandboxing with malicious-extension assumptions",
    purpose: "Every extension treated as potentially malicious with explicit minimal permissions",
    status: "not_started",
    priority: 70,
    acceptanceCriteria: [
      "Permission scoping explicit and minimal",
      "Memory poisoning risks mitigated",
      "No global memoria writes without authority policy",
      "Extension isolation verified",
      "Trust policy integration with Dharma",
    ],
    memoryBank: "tribunus-security",
  },
];

const LANES: Array<Omit<Lane, "id" | "createdAt" | "updatedAt" | "createdBy"> & { slug: string; missionId: string }> = [
  // Valkey Coordination Kernel lanes
  {
    type: "lane",
    missionId: "",
    name: "Stream Binding",
    slug: "stream-binding",
    description: "Bind work queue to Valkey streams",
    scope: "valkey-streams",
    status: "idle",
    isReadOnly: false,
    writePaths: ["/packages/opencode/src/tribunus/control-plane"],
    streamKey: "tribunus:work-queue",
    consumerGroup: "work-queue-consumers",
  },
  {
    type: "lane",
    missionId: "",
    name: "Lease Management",
    slug: "lease-management",
    description: "Implement single-writer-per-scope lease semantics",
    scope: "lane-leases",
    status: "idle",
    isReadOnly: false,
    writePaths: ["/packages/opencode/src/tribunus/control-plane"],
  },
  {
    type: "lane",
    missionId: "",
    name: "Recovery",
    slug: "recovery",
    description: "Handle stream failures and recovery",
    scope: "recovery",
    status: "idle",
    isReadOnly: false,
    writePaths: ["/packages/opencode/src/tribunus/control-plane"],
  },
];

const TASKS: Array<Omit<Task, "id" | "createdAt" | "updatedAt" | "createdBy"> & { slug: string; laneId: string; missionId: string }> = [
  // Valkey Coordination Kernel tasks
  {
    type: "task",
    laneId: "",
    missionId: "",
    name: "Implement Valkey stream adapter",
    slug: "implement-valkey-stream-adapter",
    description: "Create adapter that binds work queue to Valkey streams",
    status: "pending",
    priority: 100,
    estimatedEffort: "2 days",
    dependsOn: [],
    blocks: [],
  },
  {
    type: "task",
    laneId: "",
    missionId: "",
    name: "Implement consumer group management",
    slug: "implement-consumer-group-management",
    description: "Manage consumer groups for each lane",
    status: "pending",
    priority: 90,
    estimatedEffort: "1 day",
    dependsOn: [""], // Will be set to stream adapter task
    blocks: [],
  },
  {
    type: "task",
    laneId: "",
    missionId: "",
    name: "Implement lease acquisition",
    slug: "implement-lease-acquisition",
    description: "Acquire and renew leases for lane scopes",
    status: "pending",
    priority: 80,
    estimatedEffort: "1 day",
    dependsOn: [""],
    blocks: [],
  },
  {
    type: "task",
    laneId: "",
    missionId: "",
    name: "Implement lease release",
    slug: "implement-lease-release",
    description: "Release leases on lane completion or failure",
    status: "pending",
    priority: 80,
    estimatedEffort: "1 day",
    dependsOn: [""],
    blocks: [],
  },
  {
    type: "task",
    laneId: "",
    missionId: "",
    name: "Implement stream recovery",
    slug: "implement-stream-recovery",
    description: "Handle stream failures and replay from checkpoint",
    status: "pending",
    priority: 70,
    estimatedEffort: "2 days",
    dependsOn: [""],
    blocks: [],
  },
];

// ============================================================================
// IDEMPOTENT INITIALIZATION
// ============================================================================

async function main() {
  console.log("Initializing Tribunus Control Plane...\n");

  const result: InitResult = {
    project: { created: false, id: "", existingId: undefined },
    campaign: { created: false, id: "", existingId: undefined },
    missions: [],
    lanes: [],
    tasks: [],
    summary: { totalCreated: 0, totalExisting: 0, totalSkipped: 0 },
  };

  // Create or get project
  let existingProject = tribunusProjectGetBySlug(PROJECT_SLUG, DB_PATH);
  if (existingProject) {
    result.project = { created: false, id: existingProject.id, existingId: existingProject.id };
    result.summary.totalExisting++;
    console.log(`✓ Project exists: ${existingProject.name} (${existingProject.id})`);
  } else {
    const projectReceipt = tribunusProjectCreate(PROJECT, DB_PATH);
    if (!projectReceipt.success) {
      console.error("✗ Failed to create project:", projectReceipt.error);
      closeDb();
      process.exit(1);
    }
    const project = projectReceipt.output as Project;
    result.project = { created: true, id: project.id };
    result.summary.totalCreated++;
    console.log(`✓ Project created: ${project.name} (${project.id})`);
    existingProject = project;
  }

  // Create or get campaign
  let existingCampaign = tribunusCampaignGetBySlug(existingProject.id, CAMPAIGN_SLUG, DB_PATH);
  if (existingCampaign) {
    result.campaign = { created: false, id: existingCampaign.id, existingId: existingCampaign.id };
    result.summary.totalExisting++;
    console.log(`✓ Campaign exists: ${existingCampaign.name} (${existingCampaign.id})`);
  } else {
    const campaignWithProject: typeof CAMPAIGN = {
      ...CAMPAIGN,
      projectId: existingProject.id,
    };
    const campaignReceipt = tribunusCampaignCreate(campaignWithProject, DB_PATH);
    if (!campaignReceipt.success) {
      console.error("✗ Failed to create campaign:", campaignReceipt.error);
      closeDb();
      process.exit(1);
    }
    const campaign = campaignReceipt.output as Campaign;
    result.campaign = { created: true, id: campaign.id };
    result.summary.totalCreated++;
    console.log(`✓ Campaign created: ${campaign.name} (${campaign.id})`);
    existingCampaign = campaign;
  }

  // Create or get missions
  for (const mission of MISSIONS) {
    const missionWithCampaign: typeof mission = {
      ...mission,
      campaignId: existingCampaign.id,
    };
    
    let existingMission = tribunusMissionGetBySlug(existingCampaign.id, mission.slug, DB_PATH);
    if (existingMission) {
      result.missions.push({ created: false, id: existingMission.id, name: existingMission.name, existingId: existingMission.id });
      result.summary.totalExisting++;
      console.log(`  ✓ Mission exists: ${existingMission.name} (${existingMission.id})`);
    } else {
      const receipt = tribunusMissionCreate(missionWithCampaign, DB_PATH);
      if (!receipt.success) {
        console.error("✗ Failed to create mission:", mission.name, receipt.error);
        closeDb();
        process.exit(1);
      }
      const created = receipt.output as Mission;
      result.missions.push({ created: true, id: created.id, name: created.name });
      result.summary.totalCreated++;
      console.log(`  ✓ Mission created: ${created.name} (${created.id})`);
    }
  }

  // Get all missions for lane/task creation
  const allMissions = result.missions.map(m => {
    if (m.created) {
      return { id: m.id, name: m.name };
    } else {
      const existing = tribunusMissionGetBySlug(existingCampaign.id, MISSIONS.find(mm => mm.name === m.name)?.slug || "", DB_PATH);
      return existing ? { id: existing.id, name: existing.name } : null;
    }
  }).filter(Boolean) as Array<{ id: string; name: string }>;

  // Create or get lanes (assign to first mission)
  const firstMissionId = allMissions[0]?.id || "";
  for (const lane of LANES) {
    const laneWithMission: typeof lane = {
      ...lane,
      missionId: firstMissionId,
    };
    
    let existingLane = tribunusLaneGetBySlug(firstMissionId, lane.slug, DB_PATH);
    if (existingLane) {
      result.lanes.push({ created: false, id: existingLane.id, name: existingLane.name, existingId: existingLane.id });
      result.summary.totalExisting++;
      console.log(`  ✓ Lane exists: ${existingLane.name} (${existingLane.id})`);
    } else {
      const receipt = tribunusLaneCreate(laneWithMission, DB_PATH);
      if (!receipt.success) {
        console.error("✗ Failed to create lane:", lane.name, receipt.error);
        closeDb();
        process.exit(1);
      }
      const created = receipt.output as Lane;
      result.lanes.push({ created: true, id: created.id, name: created.name });
      result.summary.totalCreated++;
      console.log(`  ✓ Lane created: ${created.name} (${created.id})`);
    }
  }

  // Get all lanes for task creation
  const allLanes = result.lanes.map(l => {
    if (l.created) {
      return { id: l.id, name: l.name };
    } else {
      const existing = tribunusLaneGetBySlug(firstMissionId, LANES.find(ll => ll.name === l.name)?.slug || "", DB_PATH);
      return existing ? { id: existing.id, name: existing.name } : null;
    }
  }).filter(Boolean) as Array<{ id: string; name: string }>;

  // Create or get tasks (assign to first lane and first mission)
  const firstLaneId = allLanes[0]?.id || "";
  
  // Build dependency map
  const taskSlugToId: Record<string, string> = {};
  
  for (const task of TASKS) {
    const taskWithLane: typeof task = {
      ...task,
      laneId: firstLaneId,
      missionId: firstMissionId,
    };
    
    // Resolve dependencies
    const resolvedDeps = task.dependsOn.map(depSlug => {
      const depTask = TASKS.find(t => t.slug === depSlug);
      return taskSlugToId[depSlug] || "";
    });
    
    const taskWithDeps: typeof task = {
      ...taskWithLane,
      dependsOn: resolvedDeps,
    };
    
    let existingTask = tribunusTaskGetBySlug(firstMissionId, task.slug, DB_PATH);
    if (existingTask) {
      result.tasks.push({ created: false, id: existingTask.id, name: existingTask.name, existingId: existingTask.id });
      result.summary.totalExisting++;
      taskSlugToId[task.slug] = existingTask.id;
      console.log(`  ✓ Task exists: ${existingTask.name} (${existingTask.id})`);
    } else {
      const receipt = tribunusTaskCreate(taskWithDeps, DB_PATH);
      if (!receipt.success) {
        console.error("✗ Failed to create task:", task.name, receipt.error);
        closeDb();
        process.exit(1);
      }
      const created = receipt.output as Task;
      result.tasks.push({ created: true, id: created.id, name: created.name });
      result.summary.totalCreated++;
      taskSlugToId[task.slug] = created.id;
      console.log(`  ✓ Task created: ${created.name} (${created.id})`);
    }
  }

  console.log("\n✓ Tribunus Control Plane initialized successfully!");
  console.log(`  - Project: ${result.project.id} (${result.project.created ? "created" : "existing"})`);
  console.log(`  - Campaign: ${result.campaign.id} (${result.campaign.created ? "created" : "existing"})`);
  console.log(`  - Missions: ${result.missions.length} (${result.missions.filter(m => m.created).length} created, ${result.missions.filter(m => !m.created).length} existing)`);
  console.log(`  - Lanes: ${result.lanes.length} (${result.lanes.filter(l => l.created).length} created, ${result.lanes.filter(l => !l.created).length} existing)`);
  console.log(`  - Tasks: ${result.tasks.length} (${result.tasks.filter(t => t.created).length} created, ${result.tasks.filter(t => !t.created).length} existing)`);
  console.log(`\nDatabase: ${DB_PATH}`);
  console.log(`\nSummary: ${result.summary.totalCreated} created, ${result.summary.totalExisting} existing, 0 skipped`);

  closeDb();
}

main();
