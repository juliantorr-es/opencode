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
  name: "start_task",
  label: "Start Task",
  description: "Transition a task from pending to in_progress. Sets startedAt and optionally assignedTo. Reads and updates the task JSON file in docs/json/omp/tasks/.",

  parameters: pi.zod.object({
    id: pi.zod.string().describe("Task ID to start"),
    assignedTo: pi.zod.string().optional().describe("Agent or user assigned to this task (defaults to session ID)"),
    reason: pi.zod.string().optional().describe("Reason for starting the task"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("start_task cancelled");

    const filePath = findEntityFile(pi.cwd, "tasks", params.id);
    if (!filePath) {
      return { content: [{ type: "text", text: `NOT_FOUND: Task '${params.id}' does not exist` }], details: { taskId: params.id, status: "fail" } };
    }

    let task: Record<string, unknown>;
    try { task = JSON.parse(readFileSync(filePath, "utf8")); } catch (e) { return { content: [{ type: "text", text: `PARSE_ERROR: ${e}` }], details: { taskId: params.id, status: "fail" } }; }

    if (task.status !== "pending") {
      return { content: [{ type: "text", text: `INVALID_TRANSITION: Task '${params.id}' is already '${task.status}'` }], details: { taskId: params.id, status: "fail" } };
    }

    const now = new Date().toISOString();
    const assignee = params.assignedTo || ctx.sessionId || "system";
    task.status = "in_progress";
    task.startedAt = now;
    task.assignedTo = assignee;
    task.updated_at = now;

    try { writeFileSync(filePath, JSON.stringify(task, null, 2), "utf8"); } catch (e) { throw new Error(`Failed to write task: ${e}`); }

    onUpdate?.({ content: [{ type: "text", text: `Started task ${params.id} (pending → in_progress, assigned: ${assignee})` }], details: { status: "started", taskId: params.id, newStatus: "in_progress", assignedTo: assignee } });
    artifactLog(pi, ctx, { action: "start_task", taskId: params.id, assignedTo: assignee, reason: params.reason, sessionId: ctx.sessionId });

    return { content: [{ type: "text", text: `Task '${params.id}' started (pending → in_progress, assigned: ${assignee})` }], details: { taskId: params.id, status: "started", newStatus: "in_progress", assignedTo: assignee } };
  },
});

export default factory;
