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
  name: "start_lane",
  label: "Start Lane",
  description: "Transition a lane from idle to active. Acquires the lease by setting currentLeaseHolder and leaseAcquiredAt. Reads and updates the lane JSON file in docs/json/omp/lanes/.",

  parameters: pi.zod.object({
    id: pi.zod.string().describe("Lane ID to start"),
    leaseHolder: pi.zod.string().optional().describe("Agent or process ID acquiring the lease (defaults to session ID)"),
    reason: pi.zod.string().optional().describe("Reason for starting the lane"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("start_lane cancelled");

    const filePath = findEntityFile(pi.cwd, "lanes", params.id);
    if (!filePath) {
      return { content: [{ type: "text", text: `NOT_FOUND: Lane '${params.id}' does not exist` }], details: { laneId: params.id, status: "fail" } };
    }

    let lane: Record<string, unknown>;
    try { lane = JSON.parse(readFileSync(filePath, "utf8")); } catch (e) { return { content: [{ type: "text", text: `PARSE_ERROR: ${e}` }], details: { laneId: params.id, status: "fail" } }; }

    if (lane.status !== "idle") {
      return { content: [{ type: "text", text: `INVALID_TRANSITION: Lane '${params.id}' is already '${lane.status}'` }], details: { laneId: params.id, status: "fail" } };
    }

    const now = new Date().toISOString();
    const holder = params.leaseHolder || ctx.sessionId || "system";
    lane.status = "active";
    lane.currentLeaseHolder = holder;
    lane.leaseAcquiredAt = now;
    lane.updated_at = now;

    try { writeFileSync(filePath, JSON.stringify(lane, null, 2), "utf8"); } catch (e) { throw new Error(`Failed to write lane: ${e}`); }

    onUpdate?.({ content: [{ type: "text", text: `Started lane ${params.id} (idle → active, lease: ${holder})` }], details: { status: "started", laneId: params.id, newStatus: "active", leaseHolder: holder } });
    artifactLog(pi, ctx, { action: "start_lane", laneId: params.id, leaseHolder: holder, reason: params.reason, sessionId: ctx.sessionId });

    return { content: [{ type: "text", text: `Lane '${params.id}' started (idle → active, lease: ${holder})` }], details: { laneId: params.id, status: "started", newStatus: "active", leaseHolder: holder } };
  },
});

export default factory;
