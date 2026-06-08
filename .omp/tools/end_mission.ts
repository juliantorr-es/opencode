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

const factory: CustomToolFactory = (pi) => ({
  name: "end_mission",
  label: "End Mission",
  description: "Transition a mission to a terminal state (completed, blocked, or abandoned). Reads and updates the mission JSON file in docs/json/omp/missions/.",

  parameters: pi.zod.object({
    id: pi.zod.string().describe("Mission ID to end"),
    status: pi.zod.enum(TERMINAL_STATES).default("completed").describe("Terminal status"),
    reason: pi.zod.string().optional().describe("Reason for ending the mission"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("end_mission cancelled");

    const filePath = findEntityFile(pi.cwd, "missions", params.id);
    if (!filePath) {
      return { content: [{ type: "text", text: `NOT_FOUND: Mission '${params.id}' does not exist` }], details: { missionId: params.id, status: "fail" } };
    }

    let mission: Record<string, unknown>;
    try { mission = JSON.parse(readFileSync(filePath, "utf8")); } catch (e) { return { content: [{ type: "text", text: `PARSE_ERROR: ${e}` }], details: { missionId: params.id, status: "fail" } }; }

    if (mission.status === "completed" || mission.status === "blocked" || mission.status === "abandoned") {
      return { content: [{ type: "text", text: `ALREADY_TERMINAL: Mission '${params.id}' is already '${mission.status}'` }], details: { missionId: params.id, status: "fail" } };
    }

    const now = new Date().toISOString();
    const previousStatus = mission.status;
    mission.status = params.status;
    mission.updated_at = now;

    try { writeFileSync(filePath, JSON.stringify(mission, null, 2), "utf8"); } catch (e) { throw new Error(`Failed to write mission: ${e}`); }

    onUpdate?.({ content: [{ type: "text", text: `Ended mission ${params.id} (${previousStatus} → ${params.status})` }], details: { status: "ended", missionId: params.id, previousStatus, newStatus: params.status } });
    artifactLog(pi, ctx, { action: "end_mission", missionId: params.id, previousStatus, newStatus: params.status, reason: params.reason, sessionId: ctx.sessionId });

    return { content: [{ type: "text", text: `Mission '${params.id}' ended (${previousStatus} → ${params.status})` }], details: { missionId: params.id, status: "ended", previousStatus, newStatus: params.status } };
  },
});

export default factory;
