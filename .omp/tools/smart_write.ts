import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function r(worktree: string, p: string): string {
  return resolve(worktree, p);
}

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
    // Silently fail - analytics are non-critical
  }
}

const factory: CustomToolFactory = (pi) => ({
  name: "smart_write",
  label: "Smart Write",
  description:
    "Create new files or overwrite existing ones. Automatically creates parent directories. Returns a concise status and write metadata.",

  parameters: pi.zod.object({
    file_path: pi.zod.string().describe("Path to create relative to the worktree"),
    content: pi.zod.string().describe("File contents to write"),
    reason: pi.zod.string().optional().describe("Why this file is being created"),
    overwrite: pi.zod.boolean().optional().describe("Allow overwriting an existing file"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("smart_write cancelled");

    const fullPath = r(pi.cwd, params.file_path);
    const existed = existsSync(fullPath);

    onUpdate?.({
      content: [{ type: "text", text: `${existed ? "Updating" : "Creating"} ${params.file_path}` }],
      details: { phase: "start", file: params.file_path, existed },
    });

    if (existed && !params.overwrite) {
      return {
        content: [{ type: "text", text: `File already exists: ${params.file_path}` }],
        details: {
          status: "blocked",
          error: `File already exists: ${params.file_path}`,
          hint: "Use overwrite: true to replace the existing file, or use smart_edit for targeted changes.",
        },
      };
    }

    try {
      mkdirSync(dirname(fullPath), { recursive: true });
    } catch {
      // ignore parent directory creation errors and let writeFileSync report if needed
    }

    let previous = "";
    if (existed) {
      try {
        previous = readFileSync(fullPath, "utf8");
      } catch {
        previous = "";
      }
    }

    try {
      writeFileSync(fullPath, params.content, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Cannot write file: ${message}` }],
        details: { status: "error", error: `Cannot write file: ${message}` },
      };
    }

    const sizeBytes = Buffer.byteLength(params.content, "utf8");
    const preview = existed ? previous.slice(0, 500) : undefined;
    const diffResult = existed
      ? spawnSync("git", ["-C", pi.cwd, "diff", "--", params.file_path], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 5000,
        })
      : null
    const diff = diffResult?.stdout?.trim() || ""

    artifactLog(pi, ctx, {
      tool: "smart_write",
      file: params.file_path,
      existed,
      size_bytes: sizeBytes,
    });

    onUpdate?.({
      content: [{ type: "text", text: `${existed ? "Updated" : "Created"} ${params.file_path}` }],
      details: { phase: "complete", file: params.file_path, existed, size_bytes: sizeBytes },
    });

    return {
      content: [
        {
          type: "text",
          text:
            `${existed ? "Updated" : "Created"} ${params.file_path} (${sizeBytes} bytes)` +
            (diff ? `\n\n${diff.slice(0, 3000)}` : ""),
        },
      ],
      details: {
        status: existed ? "overwritten" : "created",
        file: params.file_path,
        reason: params.reason || "",
        size_bytes: sizeBytes,
        previous_preview: preview,
        diff: diff || undefined,
      },
    };
  },
});

export default factory;
