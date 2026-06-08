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

const factory: CustomToolFactory = (pi) => ({
  name: "start_campaign",
  label: "Start Campaign",
  description: "Transition a campaign from not_started to in_progress. Sets startDate if not already set. Reads and updates the campaign JSON file in docs/json/omp/campaigns/.",

  parameters: pi.zod.object({
    id: pi.zod.string().describe("Campaign ID to start"),
    reason: pi.zod.string().optional().describe("Reason for starting the campaign"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("start_campaign cancelled");

    const filePath = findEntityFile(pi.cwd, "campaigns", params.id);
    if (!filePath) {
      return { content: [{ type: "text", text: `NOT_FOUND: Campaign '${params.id}' does not exist` }], details: { campaignId: params.id, status: "fail" } };
    }

    let campaign: Record<string, unknown>;
    try { campaign = JSON.parse(readFileSync(filePath, "utf8")); } catch (e) { return { content: [{ type: "text", text: `PARSE_ERROR: ${e}` }], details: { campaignId: params.id, status: "fail" } }; }

    if (campaign.status !== "not_started") {
      return { content: [{ type: "text", text: `INVALID_TRANSITION: Campaign '${params.id}' is already '${campaign.status}'` }], details: { campaignId: params.id, status: "fail" } };
    }

    const now = new Date().toISOString();
    campaign.status = "in_progress";
    campaign.updated_at = now;
    if (!campaign.startDate) campaign.startDate = now.slice(0, 10);

    try { writeFileSync(filePath, JSON.stringify(campaign, null, 2), "utf8"); } catch (e) { throw new Error(`Failed to write campaign: ${e}`); }

    onUpdate?.({ content: [{ type: "text", text: `Started campaign ${params.id} (not_started → in_progress)` }], details: { status: "started", campaignId: params.id, newStatus: "in_progress" } });
    artifactLog(pi, ctx, { action: "start_campaign", campaignId: params.id, reason: params.reason, sessionId: ctx.sessionId });

    return { content: [{ type: "text", text: `Campaign '${params.id}' started (not_started → in_progress)` }], details: { campaignId: params.id, status: "started", newStatus: "in_progress" } };
  },
});

export default factory;
