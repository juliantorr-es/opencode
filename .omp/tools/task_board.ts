import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function artifactLog(pi: { cwd: string }, ctx: { sessionId: string }, event: Record<string, unknown>): void {
  try {
    const sessionId = ctx.sessionId || "unknown";
    const dir = resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/artifacts`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(resolve(dir, `${sessionId}.v1.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch {}
}

function entityDir(worktree: string, dir: string): { path: string; glob: string; exists: boolean } {
  const p = resolve(worktree, "docs/json/omp", dir);
  const e = existsSync(p) && readdirSync(p).some((f) => f.endsWith(".v1.json"));
  return { path: p, glob: `docs/json/omp/${dir}/*.v1.json`, exists: e };
}

function readResearchLinks(worktree: string): {
  packets: Map<string, { id: string; topic: string; findings: number }>;
  entityLinks: Map<string, Array<{ packetId: string; relationship: string }>>;
} {
  const researchDir = resolve(worktree, "docs/json/omp/research");
  const linksDir = resolve(researchDir, "memory-links");
  const packets = new Map<string, { id: string; topic: string; findings: number }>();
  const entityLinks = new Map<string, Array<{ packetId: string; relationship: string }>>();

  if (!existsSync(researchDir)) return { packets, entityLinks };

  // Read packets
  const files = readdirSync(researchDir).filter((f) => f.endsWith(".v1.json"));
  for (const f of files) {
    try {
      const raw = readFileSync(resolve(researchDir, f), "utf8");
      const p = JSON.parse(raw);
      if (p.type === "research_context_packet") {
        packets.set(p.id, {
          id: p.id,
          topic: p.research_topic || "Untitled",
          findings: (p.research_findings || []).length,
        });
      }
    } catch {}
  }

  // Read memory links
  if (existsSync(linksDir)) {
    const linkFiles = readdirSync(linksDir).filter((f) => f.endsWith(".v1.json"));
    for (const f of linkFiles) {
      try {
        const raw = readFileSync(resolve(linksDir, f), "utf8");
        const link = JSON.parse(raw);
        if (link.entity_type && link.entity_id && link.memory_id) {
          const key = `${link.entity_type}:${link.entity_id}`;
          const existing = entityLinks.get(key) || [];
          existing.push({ packetId: link.memory_id, relationship: link.relationship });
          entityLinks.set(key, existing);
        }
      } catch {}
    }
  }

  // Also read linked_entities from packets directly (for packets without memory-link files)
  for (const f of files) {
    try {
      const raw = readFileSync(resolve(researchDir, f), "utf8");
      const p = JSON.parse(raw);
      if (p.type === "research_context_packet" && Array.isArray(p.linked_entities)) {
        for (const le of p.linked_entities) {
          if (le.entity_type && le.entity_id) {
            const key = `${le.entity_type}:${le.entity_id}`;
            const existing = entityLinks.get(key) || [];
            if (!existing.some((e) => e.packetId === p.id)) {
              existing.push({ packetId: p.id, relationship: le.relationship });
              entityLinks.set(key, existing);
            }
          }
        }
      }
    } catch {}
  }

  return { packets, entityLinks };
}

function runDuckDB(worktree: string, sql: string): any[] {
  const result = spawnSync("duckdb", [":memory:", "-json", "-c", sql], {
    cwd: worktree,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw new Error(`DuckDB spawn failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`DuckDB error: ${result.stderr?.slice(0, 300) || `exit ${result.status}`}`);
  try {
    return JSON.parse(result.stdout || "[]");
  } catch {
    throw new Error(`DuckDB parse failed: ${result.stdout?.slice(0, 200)}`);
  }
}

interface TaskRow {
  id: string; name: string; slug: string; status: string; priority: number;
  laneId: string; missionId: string; dependsOn: string[]; blocks: string[];
  assignedTo: string | null; estimatedEffort: string | null; actualEffort: string | null;
  startedAt: string | null; completedAt: string | null;
}
interface LaneRow {
  id: string; name: string; slug: string; status: string; scope: string;
  missionId: string; currentLeaseHolder: string | null;
  writePaths: string[]; streamKey: string | null;
}
interface MissionRow {
  id: string; name: string; slug: string; status: string; priority: number;
  campaignId: string; purpose: string; acceptanceCriteria: string[];
}
interface CampaignRow {
  id: string; name: string; slug: string; status: string; objective: string;
  startDate: string | null; endDate: string | null;
}

const factory: CustomToolFactory = (pi) => ({
  name: "task_board",
  label: "Task Board",
  description:
    "Read the full campaign->mission->lane->task hierarchy from docs/json/omp/ using DuckDB and return a structured, actionable board view. Shows status summaries, dependency chains, blockers, and prioritized next actions. The agent does not need to reason about state — the output explicitly says what to do next.",

  parameters: pi.zod.object({
    campaignId: pi.zod.string().optional().describe("Filter to a specific campaign ID"),
    missionId: pi.zod.string().optional().describe("Filter to a specific mission ID"),
    includeCompleted: pi.zod.boolean().default(false).describe("Include completed/terminal entities (default: hide them)"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("task_board cancelled");

    const sessionId = ctx.sessionId || "unknown";
    const w = pi.cwd;
    const dirs = {
      campaigns: entityDir(w, "campaigns"),
      missions: entityDir(w, "missions"),
      lanes: entityDir(w, "lanes"),
      tasks: entityDir(w, "tasks"),
    };

    const anyExist = Object.values(dirs).some((d) => d.exists);
    if (!anyExist) {
      return {
        content: [{ type: "text", text: "No control plane entities found. Use new_campaign, new_mission, new_lane, new_task to create entities." }],
        details: {
          status: "empty",
          summary: { campaigns: 0, missions: 0, lanes: 0, tasks: 0 },
          next_actions: [{ priority: 1, action: "create_campaign", detail: "No campaigns exist. Create one with new_campaign to begin." }],
        },
      };
    }

    onUpdate?.({ content: [{ type: "text", text: "Querying entities..." }], details: { phase: "reading entities" } });

    const fromClauses: string[] = [];
    if (dirs.campaigns.exists) fromClauses.push(`campaigns AS (SELECT * FROM read_json_auto('${dirs.campaigns.glob}'))`);
    if (dirs.missions.exists) fromClauses.push(`missions AS (SELECT * FROM read_json_auto('${dirs.missions.glob}'))`);
    if (dirs.lanes.exists) fromClauses.push(`lanes AS (SELECT * FROM read_json_auto('${dirs.lanes.glob}'))`);
    if (dirs.tasks.exists) fromClauses.push(`tasks AS (SELECT * FROM read_json_auto('${dirs.tasks.glob}'))`);
    const fromBlock = fromClauses.join(",\n  ");

    const summary: Record<string, Record<string, number>> = {};
    for (const [entity, d] of Object.entries(dirs)) {
      if (!d.exists) continue;
      const rows = runDuckDB(w, `WITH ${fromBlock} SELECT status, count(*) as n FROM ${entity} GROUP BY status ORDER BY n DESC`);
      summary[entity] = {};
      for (const r of rows) summary[entity][r.status as string] = r.n as number;
    }

    let campaigns: CampaignRow[] = [];
    if (dirs.campaigns.exists) {
      campaigns = runDuckDB(w, `WITH ${fromBlock} SELECT id, name, slug, status, objective, startDate, endDate FROM campaigns ORDER BY status, name`) as CampaignRow[];
      if (params.campaignId) campaigns = campaigns.filter((c) => c.id === params.campaignId);
    }

    let missions: MissionRow[] = [];
    if (dirs.missions.exists) {
      let sql = `WITH ${fromBlock} SELECT id, name, slug, status, priority, campaignId, purpose, acceptanceCriteria FROM missions`;
      if (params.campaignId) sql += ` WHERE campaignId = '${params.campaignId.replace(/'/g, "''")}'`;
      sql += ` ORDER BY priority DESC, status, name`;
      missions = runDuckDB(w, sql) as MissionRow[];
    }

    let lanes: LaneRow[] = [];
    if (dirs.lanes.exists) {
      let sql = `WITH ${fromBlock} SELECT id, name, slug, status, scope, missionId, currentLeaseHolder, writePaths, streamKey FROM lanes`;
      if (params.missionId) sql += ` WHERE missionId = '${params.missionId.replace(/'/g, "''")}'`;
      else if (params.campaignId && dirs.missions.exists) sql += ` WHERE missionId IN (SELECT id FROM missions WHERE campaignId = '${params.campaignId.replace(/'/g, "''")}')`;
      sql += ` ORDER BY status, name`;
      lanes = runDuckDB(w, sql) as LaneRow[];
    }

    let tasks: TaskRow[] = [];
    if (dirs.tasks.exists) {
      let sql = `WITH ${fromBlock} SELECT id, name, slug, status, priority, laneId, missionId, dependsOn, blocks, assignedTo, estimatedEffort, actualEffort, startedAt, completedAt FROM tasks`;
      const conditions: string[] = [];
      if (params.missionId) conditions.push(`missionId = '${params.missionId.replace(/'/g, "''")}'`);
      else if (params.campaignId && dirs.missions.exists) conditions.push(`missionId IN (SELECT id FROM missions WHERE campaignId = '${params.campaignId.replace(/'/g, "''")}')`);
      if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
      sql += ` ORDER BY priority DESC, status, name`;
      tasks = runDuckDB(w, sql) as TaskRow[];
    }

    onUpdate?.({ content: [{ type: "text", text: "Building board..." }], details: { phase: "building board" } });

    // Load research context cross-references
    const { packets: researchPackets, entityLinks } = readResearchLinks(w);
    const lookupResearch = (entityType: string, entityId: string) => {
      const links = entityLinks.get(`${entityType}:${entityId}`) || [];
      return links.map((l) => ({
        packetId: l.packetId,
        relationship: l.relationship,
        topic: researchPackets.get(l.packetId)?.topic || "Unknown",
        findings: researchPackets.get(l.packetId)?.findings || 0,
      }));
    };

    if (!params.includeCompleted) {
      const campaignTerminal = new Set(["completed", "blocked", "abandoned"]);
      const missionTerminal = new Set(["completed", "blocked", "abandoned"]);
      const laneTerminal = new Set(["completed", "failed"]);
      const taskTerminal = new Set(["completed", "failed", "skipped"]);
      campaigns = campaigns.filter((c) => !campaignTerminal.has(c.status));
      missions = missions.filter((m) => !missionTerminal.has(m.status));
      lanes = lanes.filter((l) => !laneTerminal.has(l.status));
      tasks = tasks.filter((t) => !taskTerminal.has(t.status));
    }

    interface NextAction { priority: number; entity: string; id: string; name: string; status: string; detail: string; blockers?: string[] }
    const nextActions: NextAction[] = [];

    const completedTaskIds = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id));
    const activeLaneIds = new Set(lanes.filter((l) => l.status === "active").map((l) => l.id));
    const activeMissionIds = new Set(missions.filter((m) => m.status === "in_progress").map((m) => m.id));
    const activeCampaignIds = new Set(campaigns.filter((c) => c.status === "in_progress").map((c) => c.id));

    for (const t of tasks) {
      if (t.status !== "pending") continue;
      if (!activeLaneIds.has(t.laneId)) continue;
      const unmetDeps = t.dependsOn.filter((d) => d && !completedTaskIds.has(d));
      if (unmetDeps.length === 0) {
        nextActions.push({ priority: 1, entity: "task", id: t.id, name: t.name, status: "pending", detail: `Ready to start. Lane active.${t.estimatedEffort ? " Estimated: " + t.estimatedEffort + "." : ""}` });
      } else {
        const blockerNames = tasks.filter((bt) => unmetDeps.includes(bt.id)).map((bt) => bt.name + " (" + bt.status + ")");
        nextActions.push({ priority: 5, entity: "task", id: t.id, name: t.name, status: "pending", detail: "Blocked by unmet dependencies", blockers: blockerNames.length > 0 ? blockerNames : unmetDeps });
      }
    }

    for (const t of tasks) {
      if (t.status !== "blocked") continue;
      const unmetDeps = t.dependsOn.filter((d) => d && !completedTaskIds.has(d));
    }

    for (const t of tasks) {
      if (t.status !== "pending") continue;
      if (activeLaneIds.has(t.laneId)) continue;
      const laneName = lanes.find((l) => l.id === t.laneId)?.name || t.laneId;
      nextActions.push({ priority: 6, entity: "task", id: t.id, name: t.name, status: "pending", detail: `Pending but lane "${laneName}" is not active. Start the lane first.` });
    }

    for (const t of tasks) {
      if (t.status !== "blocked") continue;
      const unmetDeps = t.dependsOn.filter((d) => d && !completedTaskIds.has(d));
      if (unmetDeps.length > 0) {
        const blockerNames = tasks.filter((bt) => unmetDeps.includes(bt.id)).map((bt) => bt.name + " (" + bt.status + ")");
        nextActions.push({ priority: 7, entity: "task", id: t.id, name: t.name, status: "blocked", detail: "Blocked by incomplete dependencies.", blockers: blockerNames.length > 0 ? blockerNames : unmetDeps });
      }
    }
    for (const l of lanes) {
      if (l.status !== "idle") continue;
      if (activeMissionIds.has(l.missionId)) {
        const missionName = missions.find((m) => m.id === l.missionId)?.name || l.missionId;
        nextActions.push({ priority: 3, entity: "lane", id: l.id, name: l.name, status: "idle", detail: `Idle lane under active mission "${missionName}". Ready to acquire lease.` });
      }
    }

    for (const m of missions) {
      if (m.status !== "not_started") continue;
      if (activeCampaignIds.has(m.campaignId)) {
        const campaignName = campaigns.find((c) => c.id === m.campaignId)?.name || m.campaignId;
        nextActions.push({ priority: 4, entity: "mission", id: m.id, name: m.name, status: "not_started", detail: `Not started under active campaign "${campaignName}".` });
      }
    }

    for (const c of campaigns) {
      if (c.status === "not_started") {
        nextActions.push({ priority: 5, entity: "campaign", id: c.id, name: c.name, status: "not_started", detail: "Campaign not yet started." });
      }
    }

    nextActions.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

    const board: any[] = [];
    for (const c of campaigns) {
      const campaignMissions = missions.filter((m) => m.campaignId === c.id);
      const missionIds = new Set(campaignMissions.map((m) => m.id));
      const campaignLanes = lanes.filter((l) => missionIds.has(l.missionId));
      const laneIds = new Set(campaignLanes.map((l) => l.id));
      const campaignTasks = tasks.filter((t) => laneIds.has(t.laneId) || missionIds.has(t.missionId));

      const entry: any = {
        id: c.id, name: c.name, status: c.status, objective: c.objective,
        missionCount: campaignMissions.length, laneCount: campaignLanes.length, taskCount: campaignTasks.length,
        linkedResearch: lookupResearch("campaign", c.id),
        missions: campaignMissions.map((m) => {
          const mLanes = campaignLanes.filter((l) => l.missionId === m.id);
          const mLaneIds = new Set(mLanes.map((l) => l.id));
          const mTasks = campaignTasks.filter((t) => mLaneIds.has(t.laneId) || t.missionId === m.id);
          return {
            id: m.id, name: m.name, status: m.status, priority: m.priority, purpose: m.purpose,
            acceptanceCriteria: m.acceptanceCriteria,
            linkedResearch: lookupResearch("mission", m.id),
            laneCount: mLanes.length, taskCount: mTasks.length,
            lanes: mLanes.map((l) => {
              const lTasks = mTasks.filter((t) => t.laneId === l.id);
              return {
                id: l.id, name: l.name, status: l.status, scope: l.scope,
                leaseHolder: l.currentLeaseHolder, streamKey: l.streamKey,
                writePaths: l.writePaths,
                linkedResearch: lookupResearch("lane", l.id),
                taskCount: lTasks.length,
                tasks: lTasks.map((t) => ({
                  id: t.id, name: t.name, status: t.status, priority: t.priority,
                  assignedTo: t.assignedTo, estimatedEffort: t.estimatedEffort, actualEffort: t.actualEffort,
                  dependsOn: t.dependsOn.filter(Boolean),
                  blocks: t.blocks.filter(Boolean),
                  linkedResearch: lookupResearch("task", t.id),
                  startedAt: t.startedAt, completedAt: t.completedAt,
                })),
              };
            }),
          };
        }),
      };
      board.push(entry);
    }

    const boardSummary = `${campaigns.length} campaigns, ${missions.length} missions, ${lanes.length} lanes, ${tasks.length} tasks. ${nextActions.length} next actions.\n\n${summary}`;
    onUpdate?.({ content: [{ type: "text", text: boardSummary.slice(0, 500) }], details: { status: "done", campaigns: campaigns.length, missions: missions.length, lanes: lanes.length, tasks: tasks.length, nextActions: nextActions.length } });

    artifactLog(pi, ctx, { action: "task_board", campaignCount: campaigns.length, missionCount: missions.length, laneCount: lanes.length, taskCount: tasks.length, nextActionCount: nextActions.length, sessionId });

    return {
      content: [{ type: "text", text: boardSummary }],
      details: { status: "ok", board, next_actions: nextActions.slice(0, 20), campaignCount: campaigns.length, missionCount: missions.length, laneCount: lanes.length, taskCount: tasks.length, nextActionCount: nextActions.length },
    };
  },
});

export default factory;
