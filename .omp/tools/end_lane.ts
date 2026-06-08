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

const TERMINAL_STATES = ["completed", "failed"] as const;

const factory: CustomToolFactory = (pi) => ({
  name: "end_lane",
  label: "End Lane",
  description: "Transition a lane to a terminal state (completed or failed). Releases the lease by clearing currentLeaseHolder and setting leaseExpiresAt. Reads and updates the lane JSON file in docs/json/omp/lanes/.",

  parameters: pi.zod.object({
    id: pi.zod.string().describe("Lane ID to end"),
    status: pi.zod.enum(TERMINAL_STATES).default("completed").describe("Terminal status"),
    reason: pi.zod.string().optional().describe("Reason for ending the lane"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("end_lane cancelled");

    const filePath = findEntityFile(pi.cwd, "lanes", params.id);
    if (!filePath) {
      return { content: [{ type: "text", text: `NOT_FOUND: Lane '${params.id}' does not exist` }], details: { laneId: params.id, status: "fail" } };
    }

    let lane: Record<string, unknown>;
    try { lane = JSON.parse(readFileSync(filePath, "utf8")); } catch (e) { return { content: [{ type: "text", text: `PARSE_ERROR: ${e}` }], details: { laneId: params.id, status: "fail" } }; }

    if (lane.status === "completed" || lane.status === "failed") {
      return { content: [{ type: "text", text: `ALREADY_TERMINAL: Lane '${params.id}' is already '${lane.status}'` }], details: { laneId: params.id, status: "fail" } };
    }

    const now = new Date().toISOString();
    const previousStatus = lane.status;
    const previousHolder = lane.currentLeaseHolder;
    lane.status = params.status;
    lane.currentLeaseHolder = null;
    lane.leaseExpiresAt = now;
    lane.updated_at = now;

    try { writeFileSync(filePath, JSON.stringify(lane, null, 2), "utf8"); } catch (e) { throw new Error(`Failed to write lane: ${e}`); }

    onUpdate?.({ content: [{ type: "text", text: `Ended lane ${params.id} (${previousStatus} → ${params.status}, lease released: ${previousHolder || 'none'})` }], details: { status: "ended", laneId: params.id, previousStatus, newStatus: params.status, releasedLease: previousHolder } });
    artifactLog(pi, ctx, { action: "end_lane", laneId: params.id, previousStatus, newStatus: params.status, releasedHolder: previousHolder, reason: params.reason, sessionId: ctx.sessionId });

    return { content: [{ type: "text", text: `Lane '${params.id}' ended (${previousStatus} → ${params.status}, lease released)` }], details: { laneId: params.id, status: "ended", previousStatus, newStatus: params.status, releasedLease: previousHolder || null } };
  },
});

export default factory;
