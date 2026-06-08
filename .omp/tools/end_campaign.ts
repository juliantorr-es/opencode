import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

function artifactLog(pi: { cwd: string }, ctx: { sessionId: string }, event: Record<string, unknown>): void {
  try {
    const sessionId = ctx.sessionId || "unknown";
    const dir = resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/artifacts`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(resolve(dir, `${sessionId}.v1.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch {}
}

function findEntityFile(worktree: string, entityDir: string, id: string): string | null {
  const dir = resolve(worktree, "docs/json/omp", entityDir);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir);
  const match = files.find((f) => f.startsWith(`${id}-`) && f.endsWith(".v1.json"));
  return match ? resolve(dir, match) : null;
}

const TERMINAL_STATES = ["completed", "blocked", "abandoned"] as const;
const ACTIVE_STATES = ["not_started", "in_progress"];

const factory: CustomToolFactory = (pi) => ({
  name: "end_campaign",
  label: "End Campaign",
  description: "Transition a campaign to a terminal state (completed, blocked, or abandoned). Sets endDate. Reads and updates the campaign JSON file in docs/json/omp/campaigns/.",

  parameters: pi.zod.object({
    id: pi.zod.string().describe("Campaign ID to end"),
    status: pi.zod.enum(TERMINAL_STATES).default("completed").describe("Terminal status"),
    reason: pi.zod.string().optional().describe("Reason for ending the campaign"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("end_campaign cancelled");

    const filePath = findEntityFile(pi.cwd, "campaigns", params.id);
    if (!filePath) {
      return { content: [{ type: "text", text: `NOT_FOUND: Campaign '${params.id}' does not exist` }], details: { campaignId: params.id, status: "fail" } };
    }

    let campaign: Record<string, unknown>;
    try { campaign = JSON.parse(readFileSync(filePath, "utf8")); } catch (e) { return { content: [{ type: "text", text: `PARSE_ERROR: ${e}` }], details: { campaignId: params.id, status: "fail" } }; }

    if (campaign.status === "completed" || campaign.status === "blocked" || campaign.status === "abandoned") {
      return { content: [{ type: "text", text: `ALREADY_TERMINAL: Campaign '${params.id}' is already '${campaign.status}'` }], details: { campaignId: params.id, status: "fail" } };
    }

    const now = new Date().toISOString();
    const previousStatus = campaign.status;
    campaign.status = params.status;
    campaign.endDate = now.slice(0, 10);
    campaign.updated_at = now;

    try { writeFileSync(filePath, JSON.stringify(campaign, null, 2), "utf8"); } catch (e) { throw new Error(`Failed to write campaign: ${e}`); }

    onUpdate?.({ content: [{ type: "text", text: `Ended campaign ${params.id} (${previousStatus} → ${params.status})` }], details: { status: "ended", campaignId: params.id, previousStatus, newStatus: params.status } });
    artifactLog(pi, ctx, { action: "end_campaign", campaignId: params.id, previousStatus, newStatus: params.status, reason: params.reason, sessionId: ctx.sessionId });

    return { content: [{ type: "text", text: `Campaign '${params.id}' ended (${previousStatus} → ${params.status})` }], details: { campaignId: params.id, status: "ended", previousStatus, newStatus: params.status } };
  },
});

export default factory;
