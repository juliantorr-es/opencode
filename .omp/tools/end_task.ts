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

const TERMINAL_STATES = ["completed", "failed", "blocked", "skipped"] as const;

const factory: CustomToolFactory = (pi) => ({
  name: "end_task",
  label: "End Task",
  description: "Transition a task to a terminal state (completed, failed, blocked, or skipped). Sets completedAt and optionally actualEffort. Reads and updates the task JSON file in docs/json/omp/tasks/.",

  parameters: pi.zod.object({
    id: pi.zod.string().describe("Task ID to end"),
    status: pi.zod.enum(TERMINAL_STATES).default("completed").describe("Terminal status"),
    actualEffort: pi.zod.string().optional().describe("Actual effort spent (e.g., '3 hours')"),
    reason: pi.zod.string().optional().describe("Reason for ending the task"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("end_task cancelled");

    const filePath = findEntityFile(pi.cwd, "tasks", params.id);
    if (!filePath) {
      return { content: [{ type: "text", text: `NOT_FOUND: Task '${params.id}' does not exist` }], details: { taskId: params.id, status: "fail" } };
    }

    let task: Record<string, unknown>;
    try { task = JSON.parse(readFileSync(filePath, "utf8")); } catch (e) { return { content: [{ type: "text", text: `PARSE_ERROR: ${e}` }], details: { taskId: params.id, status: "fail" } }; }

    if (task.status === "completed" || task.status === "failed" || task.status === "skipped") {
      return { content: [{ type: "text", text: `ALREADY_TERMINAL: Task '${params.id}' is already '${task.status}'` }], details: { taskId: params.id, status: "fail" } };
    }

    const now = new Date().toISOString();
    const previousStatus = task.status;
    task.status = params.status;
    task.completedAt = now;
    task.updated_at = now;
    if (params.actualEffort) task.actualEffort = params.actualEffort;

    try { writeFileSync(filePath, JSON.stringify(task, null, 2), "utf8"); } catch (e) { throw new Error(`Failed to write task: ${e}`); }

    onUpdate?.({ content: [{ type: "text", text: `Ended task ${params.id} (${previousStatus} → ${params.status})` }], details: { status: "ended", taskId: params.id, previousStatus, newStatus: params.status } });
    artifactLog(pi, ctx, { action: "end_task", taskId: params.id, previousStatus, newStatus: params.status, actualEffort: params.actualEffort, reason: params.reason, sessionId: ctx.sessionId });

    return { content: [{ type: "text", text: `Task '${params.id}' ended (${previousStatus} → ${params.status})` }], details: { taskId: params.id, status: "ended", previousStatus, newStatus: params.status } };
  },
});

export default factory;
