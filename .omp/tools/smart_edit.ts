import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
  name: "smart_edit",
  label: "Smart Edit",
  description:
    "Edit files with exact text replacement. Every edit is validated before application. Use smart_batch for multi-file atomic changes.",

  parameters: pi.zod.object({
    file_path: pi.zod.string().describe("Path to the file to edit relative to the worktree"),
    old_text: pi.zod.string().describe("Exact text to replace"),
    new_text: pi.zod.string().describe("Replacement text"),
    reason: pi.zod.string().optional().describe("Why this edit is being made"),
    replace_all: pi.zod.boolean().optional().describe("Replace all occurrences instead of the first one"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("smart_edit cancelled");

    const fullPath = r(pi.cwd, params.file_path);
    if (!existsSync(fullPath)) {
      return {
        content: [{ type: "text", text: `File not found: ${params.file_path}` }],
        details: { status: "error", error: `File not found: ${params.file_path}` },
      };
    }

    let content = "";
    try {
      content = readFileSync(fullPath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Cannot read file: ${message}` }],
        details: { status: "error", error: `Cannot read file: ${message}` },
      };
    }

    const occurrences = content.split(params.old_text).length - 1;
    if (occurrences === 0) {
      return {
        content: [
          {
            type: "text",
            text: "old_text not found in file. The text must match exactly including whitespace and indentation.",
          },
        ],
        details: {
          status: "error",
          error: "old_text not found in file. The text must match exactly including whitespace and indentation.",
          hint: "Check for trailing whitespace, tabs vs spaces, or line ending differences.",
        },
      };
    }

    if (occurrences > 1 && !params.replace_all) {
      return {
        content: [{ type: "text", text: `old_text found ${occurrences} times in the file.` }],
        details: {
          status: "ambiguous",
          error: `old_text found ${occurrences} times in the file.`,
          hint: "Use replace_all: true to replace all occurrences, or make old_text more specific.",
          occurrences,
        },
      };
    }

    onUpdate?.({
      content: [{ type: "text", text: `Editing ${params.file_path}` }],
      details: { phase: "start", file: params.file_path, occurrences },
    });

    const newContent = params.replace_all
      ? content.replaceAll(params.old_text, params.new_text)
      : content.replace(params.old_text, params.new_text);

    try {
      writeFileSync(fullPath, newContent, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Cannot write file: ${message}` }],
        details: { status: "error", error: `Cannot write file: ${message}` },
      };
    }

    artifactLog(pi, ctx, {
      tool: "smart_edit",
      file: params.file_path,
      occurrences: params.replace_all ? occurrences : 1,
    });

    const diffResult = spawnSync("git", ["-C", pi.cwd, "diff", "--", params.file_path], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5000,
    });
    const diff = diffResult.stdout?.trim() || ""

    onUpdate?.({
      content: [{ type: "text", text: `Edited ${params.file_path}` }],
      details: { phase: "complete", file: params.file_path, occurrences },
    });

    return {
      content: [
        {
          type: "text",
          text:
            `Applied edit to ${params.file_path} (${params.replace_all ? occurrences : 1} occurrence${(params.replace_all ? occurrences : 1) === 1 ? "" : "s"})` +
            (diff ? `\n\n${diff.slice(0, 3000)}` : ""),
        },
      ],
      details: {
        status: "applied",
        file: params.file_path,
        reason: params.reason || "",
        occurrences: params.replace_all ? occurrences : 1,
        diff: diff || undefined,
      },
    };
  },
});

export default factory;
