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
      resolve(dir, "new_campaign_usage.v1.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), tool, ...extra }) + "\n",
      "utf8"
    );
  } catch {
    // Silently fail
  }
}

function findNextId(dir: string, prefix?: string): string {
  if (!existsSync(dir)) return "0001";
  const files = readdirSync(dir);
  const numbers = files
    .map((f) => {
      const match = f.match(/^(\d{4})-/);
      if (!match) return 0;
      const num = parseInt(match[1], 10);
      if (prefix && !f.startsWith(`${match[0]}${prefix}`)) return 0;
      return num;
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
  name: "new_campaign",
  label: "New Campaign",
  description:
    "Create a new Campaign in the Tribunus control plane. Campaigns orchestrate multiple missions toward a unified goal. Writes to docs/json/omp/campaigns/NNNN-slug.v1.json.",

  parameters: pi.zod.object({
    title: pi.zod.string().describe("Campaign name (e.g., 'Authority Binding and Kernel Completion')"),
    description: pi.zod.string().describe("Campaign description and context"),
    objective: pi.zod.string().describe("Campaign objective — the unified goal this campaign orchestrates toward"),
    status: pi.zod
      .enum(["not_started", "in_progress", "blocked", "completed", "abandoned"])
      .default("not_started")
      .describe("Campaign status"),
    projectId: pi.zod.string().optional().describe("Parent project ID (validates existence in docs/json/omp/projects/)"),
    startDate: pi.zod.string().optional().describe("Start date (ISO 8601)"),
    endDate: pi.zod.string().optional().describe("End date (ISO 8601)"),
    memoryBank: pi.zod.string().default("tribunus-core").describe("Mnemopi memory bank name"),
    authors: pi.zod.array(pi.zod.string()).default([]).describe("List of author identifiers"),
    tags: pi.zod.array(pi.zod.string()).default([]).describe("List of tags"),
    research_packet_id: pi.zod.string().optional().describe("Research packet ID to extract defaults from"),
    spec_index: pi.zod.number().optional().default(0).describe("Index into implementation_specs array (used with research_packet_id)"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("new_campaign cancelled");

    const sessionId = ctx.sessionId || "unknown";

    if (params.projectId) {
      const exists = parentExists(pi.cwd, "projects", params.projectId);
      if (!exists) {
        return {
          content: [{ type: "text", text: `INVALID_PARENT: Project '${params.projectId}' does not exist` }],
          details: { campaignId: null, status: "fail" },
        };
      }
    }

    // Research packet defaults — use suggested_campaign values when params are empty
    if (params.research_packet_id) {
      const specIndex = params.spec_index ?? 0;
      const packetPath = resolve(pi.cwd, "docs/json/omp/research", `${params.research_packet_id}.v1.json`);
      if (existsSync(packetPath)) {
        try {
          const packetContent = readFileSync(packetPath, "utf8");
          const packet = JSON.parse(packetContent);
          const specs = packet.implementation_specs;
          if (specs && specIndex >= 0 && specIndex < specs.length) {
            const spec = specs[specIndex];
            const sc = spec?.suggested_campaign;
            if (sc) {
              if (!params.title) params.title = sc.title;
              if (!params.objective) params.objective = sc.objective;
            }
          }
        } catch {
          // Silently ignore packet read/parse errors
        }
      }
    }

    const campaignId = findNextId(resolve(pi.cwd, "docs/json/omp/campaigns"));
    const slug = slugify(params.title);
    const fileName = `${campaignId}-${slug}.v1.json`;
    const campaignsDir = resolve(pi.cwd, "docs/json/omp/campaigns");
    const filePath = resolve(campaignsDir, fileName);

    onUpdate?.({
      content: [{ type: "text", text: `Creating campaign ${campaignId}...` }],
      details: { status: "creating", campaignId, fileName },
    });

    const now = new Date().toISOString();
    const campaign = {
      schema: "rig.relay.campaign.v1",
      schema_version: "v1",
      id: campaignId,
      type: "campaign",
      name: params.title,
      slug,
      description: params.description,
      objective: params.objective,
      status: params.status,
      projectId: params.projectId || null,
      startDate: params.startDate || now.slice(0, 10),
      endDate: params.endDate || null,
      memoryBank: params.memoryBank,
      authors: params.authors,
      tags: params.tags,
      created_at: now,
      updated_at: now,
    };

    try {
      mkdirSync(campaignsDir, { recursive: true });
      writeFileSync(filePath, JSON.stringify(campaign, null, 2), "utf8");
    } catch (error) {
      throw new Error(`Failed to write campaign: ${error}`);
    }

    const sizeBytes = Buffer.byteLength(JSON.stringify(campaign), "utf8");

    artifactLog(pi, ctx, {
      action: "new_campaign",
      campaignId,
      fileName,
      filePath: `docs/json/omp/campaigns/${fileName}`,
      sizeBytes,
      sessionId,
    });

    analytics(pi, ctx, "new_campaign", {
      campaignId,
      fileName,
      status: "success",
    });

    onUpdate?.({
      content: [{ type: "text", text: `Created campaign ${campaignId} at docs/json/omp/campaigns/${fileName}` }],
      details: { status: "created", campaignId, fileName, sizeBytes },
    });

    return {
      content: [{ type: "text", text: `New campaign ${campaignId} created at docs/json/omp/campaigns/${fileName} (${sizeBytes} bytes)` }],
      details: { campaignId, fileName, status: "created", sizeBytes },
    };
  },
});

export default factory;
