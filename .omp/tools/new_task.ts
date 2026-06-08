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
      resolve(dir, "new_task_usage.v1.jsonl"),
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
  name: "new_task",
  label: "New Task",
  description:
    "Create a new Task within a Lane and Mission. Tasks are the smallest unit of work with dependency tracking, effort estimates, and execution context. Writes to docs/json/omp/tasks/NNNN-slug.v1.json.",

  parameters: pi.zod.object({
    title: pi.zod.string().describe("Task name (e.g., 'Implement Valkey stream adapter')"),
    description: pi.zod.string().describe("Task description and context"),
    laneId: pi.zod.string().describe("Parent lane ID (must exist in docs/json/omp/lanes/)"),
    missionId: pi.zod.string().describe("Parent mission ID (must exist in docs/json/omp/missions/)"),
    status: pi.zod
      .enum(["pending", "in_progress", "blocked", "completed", "failed", "skipped"])
      .default("pending")
      .describe("Task status"),
    priority: pi.zod.number().min(0).max(100).default(50).describe("Priority 0-100, higher = more urgent"),
    estimatedEffort: pi.zod.string().optional().describe("Estimated effort (e.g., '2 days', '4 hours')"),
    dependsOn: pi.zod.array(pi.zod.string()).default([]).describe("Task IDs this task depends on"),
    blocks: pi.zod.array(pi.zod.string()).default([]).describe("Task IDs this task blocks"),
    assignedTo: pi.zod.string().optional().describe("Agent or user assigned to this task"),
    authors: pi.zod.array(pi.zod.string()).default([]).describe("List of author identifiers"),
    tags: pi.zod.array(pi.zod.string()).default([]).describe("List of tags"),
    researchPacketId: pi.zod.string().optional().describe("Research packet ID for extracting task template defaults"),
    specIndex: pi.zod.number().int().min(0).default(0).describe("Index into implementation_specs (default: 0)"),
    missionIndex: pi.zod.number().int().min(0).default(0).describe("Index into suggested_missions (default: 0)"),
    laneIndex: pi.zod.number().int().min(0).default(0).describe("Index into suggested_lanes (default: 0)"),
    taskIndex: pi.zod.number().int().min(0).default(0).describe("Index into suggested_tasks (default: 0)"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("new_task cancelled");

    const sessionId = ctx.sessionId || "unknown";

    const missionExists = parentExists(pi.cwd, "missions", params.missionId);
    if (!missionExists) {
      return {
        content: [{ type: "text", text: `INVALID_PARENT: Mission '${params.missionId}' does not exist` }],
        details: { taskId: null, status: "fail" },
      };
    }

    const laneExists = parentExists(pi.cwd, "lanes", params.laneId);
    if (!laneExists) {
      return {
        content: [{ type: "text", text: `INVALID_PARENT: Lane '${params.laneId}' does not exist` }],
        details: { taskId: null, status: "fail" },
      };
    }

    // Research packet template defaults for optional/unspecified fields
    let resolvedEstimatedEffort = params.estimatedEffort;
    let resolvedPriority = params.priority;
    let resolvedDependsOn = params.dependsOn;

    if (params.researchPacketId) {
      const packetPath = resolve(pi.cwd, "docs/json/omp/research", `${params.researchPacketId}.v1.json`);
      if (existsSync(packetPath)) {
        try {
          const packet = JSON.parse(readFileSync(packetPath, "utf8"));
          const template = packet.implementation_specs?.[params.specIndex]
            ?.suggested_missions?.[params.missionIndex]
            ?.suggested_lanes?.[params.laneIndex]
            ?.suggested_tasks?.[params.taskIndex];
          if (template) {
            if (params.estimatedEffort === undefined && template.estimated_effort) {
              resolvedEstimatedEffort = template.estimated_effort;
            }
            if (params.priority === 50 && template.priority !== undefined) {
              resolvedPriority = template.priority;
            }
            if (params.dependsOn.length === 0 && template.depends_on?.length) {
              resolvedDependsOn = template.depends_on;
            }
          }
        } catch {
          // Silently ignore packet read errors
        }
      }
    }

    const taskId = findNextId(resolve(pi.cwd, "docs/json/omp/tasks"));
    const slug = slugify(params.title);
    const fileName = `${taskId}-${slug}.v1.json`;
    const tasksDir = resolve(pi.cwd, "docs/json/omp/tasks");
    const filePath = resolve(tasksDir, fileName);
    onUpdate?.({
      content: [{ type: "text", text: `Creating task ${taskId}...` }],
      details: { status: "creating", taskId, laneId: params.laneId, missionId: params.missionId, fileName },
    });


    const now = new Date().toISOString();
    const task = {
      schema: "rig.relay.task.v1",
      schema_version: "v1",
      id: taskId,
      type: "task",
      name: params.title,
      slug,
      description: params.description,
      laneId: params.laneId,
      missionId: params.missionId,
      status: params.status,
      priority: resolvedPriority,
      estimatedEffort: resolvedEstimatedEffort || null,
      actualEffort: null,
      dependsOn: resolvedDependsOn,
      blocks: params.blocks,
      assignedTo: params.assignedTo || null,
      startedAt: params.status === "in_progress" ? now : null,
      completedAt: params.status === "completed" ? now : null,
      authors: params.authors,
      tags: params.tags,
      created_at: now,
      updated_at: now,
    };

    try {
      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(filePath, JSON.stringify(task, null, 2), "utf8");
    } catch (error) {
      throw new Error(`Failed to write task: ${error}`);
    }

    const sizeBytes = Buffer.byteLength(JSON.stringify(task), "utf8");

    artifactLog(pi, ctx, {
      action: "new_task",
      taskId,
      laneId: params.laneId,
      missionId: params.missionId,
      fileName,
      filePath: `docs/json/omp/tasks/${fileName}`,
      sizeBytes,
      sessionId,
    });

    analytics(pi, ctx, "new_task", {
      taskId,
      fileName,
      status: "success",
    });

    onUpdate?.({
      content: [{ type: "text", text: `Created task ${taskId} at docs/json/omp/tasks/${fileName}` }],
      details: { status: "created", taskId, fileName, sizeBytes },
    });
    return {
      content: [{ type: "text", text: `New task ${taskId} created at docs/json/omp/tasks/${fileName} (${sizeBytes} bytes)` }],
      details: { taskId, fileName, laneId: params.laneId, missionId: params.missionId, status: "created", sizeBytes },
    };
  },
});

export default factory;
