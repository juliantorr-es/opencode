import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
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
      resolve(dir, "smart_tool_usage.v1.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        session_id: sessionId,
        tool,
        ...extra,
      }) + "\n",
      "utf8"
    );
  } catch {
    // Silently fail
  }
}

const factory: CustomToolFactory = (pi) => ({
  name: "smart_sd",
  label: "Smart SD",
  description:
    "Search and replace text in files using fixed-string matching (not regex). Safer than sd/sed - no regex escaping surprises. Use this for literal text replacements.",

  parameters: pi.zod.object({
    file: pi.zod.string().describe("File to modify, relative to project root"),
    old: pi.zod.string().describe("Exact text to replace - literal match, no regex"),
    new: pi.zod.string().describe("Replacement text"),
    reason: pi.zod.string().describe("Why this replacement is needed"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("smart_sd cancelled");

    onUpdate?.({
      content: [{ type: "text", text: `Replacing in ${params.file}...` }],
      details: { phase: "start", file: params.file },
    });

    const filePath = resolve(pi.cwd, params.file);

    if (!existsSync(filePath)) {
      onUpdate?.({
        content: [{ type: "text", text: `File not found: ${params.file}` }],
        details: { status: "fail", error: "File not found" },
      });
      return {
        content: [{ type: "text", text: `File not found: ${params.file}` }],
        details: { status: "fail", error: `File not found: ${params.file}` },
      };
    }

    onUpdate?.({
      content: [{ type: "text", text: "Reading file..." }],
      details: { phase: "read" },
    });

    const original = readFileSync(filePath, "utf8");
    const count = original.split(params.old).length - 1;

    if (count === 0) {
      // Show surrounding context to help debug
      const lines = original.split("\n");
      const oldFirstLine = params.old.split("\n")[0]!.trim();
      const matches: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(oldFirstLine.slice(0, 20))) {
          matches.push(`  line ${i + 1}: ${lines[i]!.trim().slice(0, 120)}`);
        }
      }

      onUpdate?.({
        content: [{ type: "text", text: "Text not found" }],
        details: { phase: "failed", error: "old text not found" },
      });

      return {
        content: [
          {
            type: "text",
            text: `Text not found in ${params.file}. Similar lines:\n${matches.slice(0, 5).join("\n")}\n\nHint: Use read tool to check exact content. Watch for whitespace differences.`,
          },
        ],
        details: {
          status: "fail",
          error: "old text not found in file",
          similar_lines: matches.slice(0, 5),
          hint: "Use read tool to see exact file content. Check whitespace and line endings.",
        },
      };
    }

    if (count > 1) {
      onUpdate?.({
        content: [{ type: "text", text: "Multiple matches" }],
        details: { phase: "failed", error: "Multiple matches" },
      });

      return {
        content: [
          {
            type: "text",
            text: `Text matches ${count} times in ${params.file}. Must be unique. Use a larger old string that captures enough surrounding context to be unambiguous.`,
          },
        ],
        details: { status: "fail", error: `matches ${count} times - must be unique` },
      };
    }

    onUpdate?.({
      content: [{ type: "text", text: "Applying replacement..." }],
      details: { phase: "replace" },
    });

    const modified = original.replace(params.old, params.new);
    writeFileSync(filePath, modified, "utf8");

    // Post-write verification
    const verify = readFileSync(filePath, "utf8");
    if (!verify.includes(params.new)) {
      onUpdate?.({
        content: [{ type: "text", text: "Verification failed" }],
        details: { phase: "failed", error: "Write verification failed" },
      });

      return {
        content: [
          {
            type: "text",
            text: `Write verification failed - new text not found in file after write. This usually means another process modified the file simultaneously. Retry or use a file lock.`,
          },
        ],
        details: {
          status: "fail",
          error: "Write verification failed - new text not found in file after write",
          file: params.file,
        },
      };
    }

    // Record edit metadata
    const sessionId = ctx.sessionId || "unknown";
    const editDir = resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/edits`);
    try {
      if (!existsSync(editDir)) mkdirSync(editDir, { recursive: true });
      const logLine = JSON.stringify({
        schema_version: "v1",
        session_id: sessionId,
        file: params.file,
        reason: params.reason,
        change_summary: "literal replacement",
        edited_at: new Date().toISOString(),
      });
      appendFileSync(
        resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/edits/edit_log.v1.jsonl`),
        logLine + "\n",
        "utf8"
      );
    } catch {
      // Silently fail - edit logging is non-critical
    }

    // Analytics
    analytics(pi, ctx, "smart_sd", { file: params.file.slice(0, 120) });
    artifactLog(pi, ctx, { tool: "smart_sd", action: "replaced", file: params.file, detail: params.reason?.slice(0, 80) });

    onUpdate?.({
      content: [{ type: "text", text: `Replaced in ${params.file}` }],
      details: { phase: "complete", file: params.file },
    });

    return {
      content: [
        {
          type: "text",
          text: `Replaced in ${params.file}\nReason: ${params.reason}\n- ${params.old.slice(0, 100)}\n+ ${params.new.slice(0, 100)}`,
        },
      ],
      details: {
        status: "applied",
        file: params.file,
        occurrences_matched: 1,
        reason: params.reason,
        metadata_recorded: true,
      },
    };
  },
});

export default factory;
