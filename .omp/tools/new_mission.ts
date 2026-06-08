import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function artifactLog(
  pi: { cwd: string },
  ctx: { sessionId: string },
  event: Record<string, unknown>
): void {
  try {
    const sessionId = ctx.sessionId || "unknown";
    const dir = resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/artifacts`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      resolve(dir, `${sessionId}.v1.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
      "utf8"
    );
  } catch {
    // Silently fail
  }
}

function analytics(
  pi: { cwd: string },
  ctx: { sessionId: string },
  tool: string,
  extra: Record<string, unknown>
): void {
  try {
    const sessionId = ctx.sessionId || "unknown";
    const dir = resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/analytics`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      resolve(dir, "new_mission_usage.v1.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), tool, ...extra }) + "\n",
      "utf8"
    );
  } catch {
    // Silently fail
  }
}

function findNextId(dir: string, campaignPrefix?: string): string {
  if (!existsSync(dir)) return "0001";
  const files = readdirSync(dir);
  const numbers = files
    .map((f) => {
      const match = f.match(/^(\d{4})-/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);
  if (numbers.length === 0) return "0001";
  const max = Math.max(...numbers);
  return `${max + 1}`.padStart(4, "0");
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parentExists(worktree: string, parentDir: string, parentId: string): boolean {
  const dir = resolve(worktree, "docs/json/omp", parentDir);
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir);
  return files.some((f) => f.startsWith(`${parentId}-`));
}

const factory: CustomToolFactory = (pi) => ({
  name: "new_mission",
  label: "New Mission",
  description:
    "Create a new Mission within a Campaign. Missions decompose campaigns into discrete objectives with acceptance criteria. Writes to docs/json/omp/missions/NNNN-slug.v1.json.",

  parameters: pi.zod.object({
    title: pi.zod.string().describe("Mission name (e.g., 'Valkey Stream-Backed Coordination Kernel')"),
    description: pi.zod.string().describe("Mission description and context"),
    purpose: pi.zod.string().describe("Mission purpose — what this mission achieves and why it matters"),
    campaignId: pi.zod.string().describe("Parent campaign ID (must exist in docs/json/omp/campaigns/)"),
    status: pi.zod
      .enum(["not_started", "in_progress", "blocked", "completed", "abandoned"])
      .default("not_started")
      .describe("Mission status"),
    priority: pi.zod.number().min(0).max(100).default(50).describe("Priority 0-100, higher = more urgent"),
    acceptanceCriteria: pi.zod
      .array(pi.zod.string())
      .default([])
      .describe("List of verifiable acceptance criteria"),
    memoryBank: pi.zod.string().default("tribunus-core").describe("Mnemopi memory bank name"),
    authors: pi.zod.array(pi.zod.string()).default([]).describe("List of author identifiers"),
    tags: pi.zod.array(pi.zod.string()).default([]).describe("List of tags"),
    research_packet_id: pi.zod.string().optional().describe("Research context packet ID for filling defaults from a research template"),
    spec_index: pi.zod.number().int().min(0).default(0).describe("Index into implementation_specs within the research packet"),
    mission_index: pi.zod.number().int().min(0).default(0).describe("Index into suggested_missions within the selected implementation spec"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("new_mission cancelled");

    const sessionId = ctx.sessionId || "unknown";

    const campaignExists = parentExists(pi.cwd, "campaigns", params.campaignId);
    if (!campaignExists) {
      return {
        content: [{ type: "text", text: `INVALID_PARENT: Campaign '${params.campaignId}' does not exist` }],
        details: { missionId: null, status: "fail" },
      };
    }
    // Research packet template defaults
    if (params.research_packet_id) {
      const packetPath = resolve(pi.cwd, "docs/json/omp/research", `${params.research_packet_id}.v1.json`);
      if (existsSync(packetPath)) {
        try {
          const packet = JSON.parse(readFileSync(packetPath, "utf8"));
          const spec = packet.implementation_specs?.[params.spec_index];
          if (spec) {
            const tmpl = spec.suggested_missions?.[params.mission_index];
            if (tmpl) {
              if (!params.title) params.title = tmpl.title;
              if (!params.purpose) params.purpose = tmpl.purpose;
              if (params.acceptanceCriteria.length === 0 && tmpl.acceptance_criteria) {
                params.acceptanceCriteria = tmpl.acceptance_criteria;
              }
              if (params.priority === 50 && tmpl.priority !== undefined) {
                params.priority = tmpl.priority;
              }
            }
          }
        } catch {
          // Silently ignore malformed packet
        }
      }
    }

    const missionsDir = resolve(pi.cwd, "docs/json/omp/missions");
    const slug = slugify(params.title);
    const missionId = `${findNextId(missionsDir)}-${slug}`;
    const fileName = `${missionId}.v1.json`;
    const filePath = resolve(missionsDir, fileName);

    onUpdate?.({
      content: [{ type: "text", text: `Creating mission ${missionId}...` }],
      details: { status: "creating", missionId, fileName },
    });


    const now = new Date().toISOString();
    const mission = {
      schema: "rig.relay.mission.v1",
      schema_version: "v1",
      id: missionId,
      type: "mission",
      name: params.title,
      slug,
      description: params.description,
      purpose: params.purpose,
      campaignId: params.campaignId,
      status: params.status,
      priority: params.priority,
      acceptanceCriteria: params.acceptanceCriteria,
      memoryBank: params.memoryBank,
      authors: params.authors,
      tags: params.tags,
      created_at: now,
      updated_at: now,
    };

    try {
      mkdirSync(missionsDir, { recursive: true });
      writeFileSync(filePath, JSON.stringify(mission, null, 2), "utf8");
    } catch (error) {
      throw new Error(`Failed to write mission: ${error}`);
    }

    const sizeBytes = Buffer.byteLength(JSON.stringify(mission), "utf8");

    artifactLog(pi, ctx, {
      action: "new_mission",
      missionId,
      campaignId: params.campaignId,
      fileName,
      filePath: `docs/json/omp/missions/${fileName}`,
      sizeBytes,
      sessionId,
    });

    analytics(pi, ctx, "new_mission", {
      missionId,
      fileName,
      status: "success",
    });

    onUpdate?.({
      content: [{ type: "text", text: `Created mission ${missionId} at docs/json/omp/missions/${fileName}` }],
      details: { status: "created", missionId, fileName, sizeBytes },
    });

    return {
      content: [{ type: "text", text: `New mission ${missionId} created at docs/json/omp/missions/${fileName} (${sizeBytes} bytes)` }],
      details: { missionId, fileName, campaignId: params.campaignId, status: "created", sizeBytes },
    };
  },
});

export default factory;
