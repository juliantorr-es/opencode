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
  name: "start_mission",
  label: "Start Mission",
  description: "Transition a mission from not_started to in_progress. Reads and updates the mission JSON file in docs/json/omp/missions/.",

  parameters: pi.zod.object({
    id: pi.zod.string().describe("Mission ID to start"),
    reason: pi.zod.string().optional().describe("Reason for starting the mission"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("start_mission cancelled");

    const filePath = findEntityFile(pi.cwd, "missions", params.id);
    if (!filePath) {
      return { content: [{ type: "text", text: `NOT_FOUND: Mission '${params.id}' does not exist` }], details: { missionId: params.id, status: "fail" } };
    }

    let mission: Record<string, unknown>;
    try { mission = JSON.parse(readFileSync(filePath, "utf8")); } catch (e) { return { content: [{ type: "text", text: `PARSE_ERROR: ${e}` }], details: { missionId: params.id, status: "fail" } }; }

    if (mission.status !== "not_started") {
      return { content: [{ type: "text", text: `INVALID_TRANSITION: Mission '${params.id}' is already '${mission.status}'` }], details: { missionId: params.id, status: "fail" } };
    }

    const now = new Date().toISOString();
    mission.status = "in_progress";
    mission.updated_at = now;

    try { writeFileSync(filePath, JSON.stringify(mission, null, 2), "utf8"); } catch (e) { throw new Error(`Failed to write mission: ${e}`); }

    onUpdate?.({ content: [{ type: "text", text: `Started mission ${params.id} (not_started → in_progress)` }], details: { status: "started", missionId: params.id, newStatus: "in_progress" } });
    artifactLog(pi, ctx, { action: "start_mission", missionId: params.id, reason: params.reason, sessionId: ctx.sessionId });

    return { content: [{ type: "text", text: `Mission '${params.id}' started (not_started → in_progress)` }], details: { missionId: params.id, status: "started", newStatus: "in_progress" } };
  },
});

export default factory;
