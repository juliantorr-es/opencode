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
      resolve(dir, "new_lane_usage.v1.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), tool, ...extra }) + "\n",
      "utf8"
    );
  } catch {
    // Silently fail
  }
}

function findNextId(dir: string): string {
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
  name: "new_lane",
  label: "New Lane",
  description:
    "Create a new Lane within a Mission. Lanes are single-writer-per-scope work units with lease semantics and stream bindings. Writes to docs/json/omp/lanes/NNNN-slug.v1.json.",

  parameters: pi.zod.object({
    title: pi.zod.string().describe("Lane name (e.g., 'Stream Binding')"),
    description: pi.zod.string().describe("Lane description and context"),
    scope: pi.zod.string().describe("Scope identifier for single-writer-per-scope rule (e.g., 'valkey-streams')"),
    missionId: pi.zod.string().describe("Parent mission ID (must exist in docs/json/omp/missions/)"),
    status: pi.zod
      .enum(["idle", "active", "paused", "completed", "failed"])
      .default("idle")
      .describe("Lane status"),
    isReadOnly: pi.zod.boolean().default(false).describe("Whether this lane is read-only"),
    writePaths: pi.zod.array(pi.zod.string()).default([]).describe("Paths this lane can write to"),
    streamKey: pi.zod.string().optional().describe("Valkey stream key for work queue binding"),
    consumerGroup: pi.zod.string().optional().describe("Consumer group name for stream binding"),
    authors: pi.zod.array(pi.zod.string()).default([]).describe("List of author identifiers"),
    tags: pi.zod.array(pi.zod.string()).default([]).describe("List of tags"),
    research_packet_id: pi.zod.string().optional().describe("Research packet ID to extract defaults from"),
    spec_index: pi.zod.number().default(0).describe("Index into implementation_specs in the research packet"),
    mission_index: pi.zod.number().default(0).describe("Index into suggested_missions for the selected spec"),
    lane_index: pi.zod.number().default(0).describe("Index into suggested_lanes for the selected mission"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("new_lane cancelled");

    const sessionId = ctx.sessionId || "unknown";

    const missionExists = parentExists(pi.cwd, "missions", params.missionId);
    if (!missionExists) {
      return {
        content: [{ type: "text", text: `INVALID_PARENT: Mission '${params.missionId}' does not exist` }],
        details: { laneId: null, status: "fail" },
      };
    }

    // Apply research packet defaults
    if (params.research_packet_id) {
      const packetPath = resolve(pi.cwd, "docs/json/omp/research", `${params.research_packet_id}.v1.json`);
      if (existsSync(packetPath)) {
        try {
          const packet = JSON.parse(readFileSync(packetPath, "utf8"));
          const specs = packet.implementation_specs;
          if (
            Array.isArray(specs) &&
            specs[params.spec_index]?.suggested_missions?.[params.mission_index]?.suggested_lanes?.[params.lane_index]
          ) {
            const template = specs[params.spec_index].suggested_missions[params.mission_index].suggested_lanes[params.lane_index];
            if (template.title && !params.title) params.title = template.title;
            if (template.scope && !params.scope) params.scope = template.scope;
            if (template.description && !params.description) params.description = template.description;
            if (Array.isArray(template.write_paths) && template.write_paths.length && params.writePaths.length === 0) {
              params.writePaths = template.write_paths;
            }
          }
        } catch {
          // Silently continue without template defaults
        }
      }
    }

    const laneId = findNextId(resolve(pi.cwd, "docs/json/omp/lanes"));
    const slug = slugify(params.title);
    const fileName = `${laneId}-${slug}.v1.json`;
    const lanesDir = resolve(pi.cwd, "docs/json/omp/lanes");
    const filePath = resolve(lanesDir, fileName);

    onUpdate?.({
      content: [{ type: "text", text: `Creating lane ${laneId}...` }],
      details: { status: "creating", laneId, missionId: params.missionId, fileName },
    });

    const now = new Date().toISOString();
    const lane = {
      schema: "rig.relay.lane.v1",
      schema_version: "v1",
      id: laneId,
      type: "lane",
      name: params.title,
      slug,
      description: params.description,
      scope: params.scope,
      missionId: params.missionId,
      status: params.status,
      isReadOnly: params.isReadOnly,
      writePaths: params.writePaths,
      streamKey: params.streamKey || null,
      consumerGroup: params.consumerGroup || null,
      currentLeaseHolder: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      authors: params.authors,
      tags: params.tags,
      created_at: now,
      updated_at: now,
    };

    try {
      mkdirSync(lanesDir, { recursive: true });
      writeFileSync(filePath, JSON.stringify(lane, null, 2), "utf8");
    } catch (error) {
      throw new Error(`Failed to write lane: ${error}`);
    }

    const sizeBytes = Buffer.byteLength(JSON.stringify(lane), "utf8");

    artifactLog(pi, ctx, {
      action: "new_lane",
      laneId,
      missionId: params.missionId,
      fileName,
      filePath: `docs/json/omp/lanes/${fileName}`,
      sizeBytes,
      sessionId,
    });

    analytics(pi, ctx, "new_lane", {
      laneId,
      fileName,
      status: "success",
    });

    onUpdate?.({
      content: [{ type: "text", text: `Created lane ${laneId} at docs/json/omp/lanes/${fileName}` }],
      details: { status: "created", laneId, fileName, sizeBytes },
    });

    return {
      content: [{ type: "text", text: `New lane ${laneId} created at docs/json/omp/lanes/${fileName} (${sizeBytes} bytes)` }],
      details: { laneId, fileName, missionId: params.missionId, status: "created", sizeBytes },
    };
  },
});

export default factory;
