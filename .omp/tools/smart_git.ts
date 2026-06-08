import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";

function resolvePath(worktree: string, p: string): string {
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

function logBinaryUsage(
  pi: { cwd: string },
  ctx: { sessionId: string },
  binary: string,
  success: boolean
): void {
  try {
    const sessionId = ctx.sessionId || "unknown";
    const dir = resolve(pi.cwd, `docs/json/omp/sessions/${sessionId}/analytics`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      resolve(dir, "binary_usage.v1.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        session_id: sessionId,
        binary,
        success,
      }) + "\n",
      "utf8"
    );
  } catch {
    // Silently fail
  }
}

function spawnDelta(input: string): { status: number | null; stdout: string | null; stderr: string | null } {
  const binaries = ["delta", "/opt/homebrew/bin/delta", "/usr/local/bin/delta"];
  for (const bin of binaries) {
    try {
      const result = spawnSync(bin, [], {
        input,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 2,
        timeout: 5000,
      });
      if (result.status === 0) {
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      }
    } catch {
      // Try next binary
    }
  }
  return { status: null, stdout: null, stderr: null };
}

function spawnDifft(input: string): { status: number | null; stdout: string | null; stderr: string | null } {
  const binaries = ["difft", "/opt/homebrew/bin/difft", "/usr/local/bin/difft"];
  for (const bin of binaries) {
    try {
      const result = spawnSync(bin, [], {
        input,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 2,
        timeout: 10000,
      });
      if (result.status === 0) {
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      }
    } catch {
      // Try next binary
    }
  }
  return { status: null, stdout: null, stderr: null };
}

function highlightDiff(diff: string): string {
  // Pure TS basic diff highlighting - adds ANSI color codes for +/- lines
  const lines = diff.split("\n");
  return lines
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return `\x1b[32m${line}\x1b[0m`;
      if (line.startsWith("-") && !line.startsWith("---")) return `\x1b[31m${line}\x1b[0m`;
      if (line.startsWith("@@")) return `\x1b[36m${line}\x1b[0m`;
      return line;
    })
    .join("\n");
}

const factory: CustomToolFactory = (pi) => ({
  name: "smart_git",
  label: "Smart Git",
  description:
    "Run git operations (status, diff, add, commit, push, log, branch) with structured output. Replaces all git bash commands. Blocks destructive operations.",

  parameters: pi.zod.object({
    operation: pi.zod
      .string()
      .describe("status | diff | add | commit | push | log | branch | rev-parse | stash | checkout | show"),
    args: pi.zod.string().optional().describe("Additional args passed directly to git"),
    path: pi.zod
      .string()
      .optional()
      .describe("Limit to a specific file or directory (appended as '-- <path>')"),
    files: pi.zod
      .string()
      .optional()
      .describe("JSON array of file paths for add/checkout operations"),
    message: pi.zod.string().optional().describe("Commit message (for commit operation)"),
    style: pi.zod
      .string()
      .optional()
      .describe(
        "Output style for diff: 'auto' (tries difftastic then delta, default), 'difftastic' (structural AST-aware diff), 'delta' (syntax-highlighted), 'raw' (plain git diff)"
      ),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("smart_git cancelled");

    onUpdate?.({
      content: [{ type: "text", text: `Running git ${params.operation}...` }],
      details: { phase: "start", operation: params.operation },
    });

    const validOps: Record<string, string[]> = {
      status: ["status", "--porcelain"],
      diff: ["diff"],
      "diff-stat": ["diff", "--stat"],
      add: ["add"],
      commit: ["commit", "-m"],
      push: ["push"],
      log: ["log", "--oneline", "-10"],
      branch: ["branch", "--show-current"],
      "rev-parse": ["rev-parse", "HEAD"],
      stash: ["stash"],
      checkout: ["checkout"],
      show: ["show"],
    };

    if (!validOps[params.operation]) {
      onUpdate?.({
        content: [
          { type: "text", text: `Unknown operation: '${params.operation}'. Valid: ${Object.keys(validOps).join(", ")}` },
        ],
        details: { status: "error", error: "Unknown operation" },
      });
      return {
        content: [
          { type: "text", text: `Unknown operation: '${params.operation}'. Valid: ${Object.keys(validOps).join(", ")}` },
        ],
        details: { status: "error", error: `Unknown operation: '${params.operation}'`, valid: Object.keys(validOps) },
      };
    }

    // Block destructive operations
    const blockedArgs: Record<string, string[]> = {
      push: ["--force", "-f", "--delete"],
      checkout: ["--", "HEAD~"],
      stash: ["drop", "clear"],
      branch: ["-D", "--delete"],
    };
    if (blockedArgs[params.operation]) {
      const hasBlocked = blockedArgs[params.operation].some((a) => (params.args || "").includes(a));
      if (hasBlocked) {
        onUpdate?.({
          content: [{ type: "text", text: `Destructive git ${params.operation} blocked` }],
          details: { status: "blocked", operation: params.operation },
        });
        return {
          content: [
            { type: "text", text: `Destructive git ${params.operation} blocked. Use a safer alternative.` },
          ],
          details: {
            status: "blocked",
            error: `Destructive git ${params.operation} blocked`,
            blocked_args: blockedArgs[params.operation],
          },
        };
      }
    }

    const cmd = ["git", ...validOps[params.operation]];

    if (params.operation === "commit" && params.message) {
      cmd.push(params.message);
    }
    if (params.operation === "log" && params.args) {
      cmd.splice(2, 2);
      cmd.push(...params.args.split(/\s+/));
    }
    if (params.args && !["commit", "log"].includes(params.operation)) {
      cmd.push(...params.args.split(/\s+/).filter(Boolean));
    }
    if (params.path && ["status", "diff", "diff-stat", "log"].includes(params.operation)) {
      cmd.push("--", params.path);
    }
    if (params.files) {
      try {
        const files = JSON.parse(params.files);
        if (Array.isArray(files)) cmd.push(...files);
      } catch {
        // Invalid JSON, ignore
      }
    }

    onUpdate?.({
      content: [{ type: "text", text: `Executing: ${cmd.join(" ")}` }],
      details: { phase: "execute", command: cmd.join(" ") },
    });

    const result = spawnSync(cmd[0], cmd.slice(1), {
      cwd: pi.cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 2,
      timeout: 30000,
    });

    const stdout = result.stdout?.trim() || "";
    const stderr = result.stderr?.trim() || "";

    // Post-process diff output through delta or difftastic for syntax highlighting
    let styledDiff = "";
    let diffStyle = "";
    if (["diff", "diff-stat", "show"].includes(params.operation) && stdout && (params.style ?? "auto") !== "raw") {
      // Try difftastic first (structural, AST-aware)
      if (params.style === "difftastic" || params.style === "auto") {
        const difftResult = spawnDifft(stdout);
        if (difftResult.status === 0 && difftResult.stdout?.trim()) {
          styledDiff = difftResult.stdout.trim();
          diffStyle = "difftastic";
          logBinaryUsage(pi, ctx, "difft", true);
        } else {
          logBinaryUsage(pi, ctx, "difft", false);
        }
      }
      // Fall back to delta (syntax highlighting)
      if (!styledDiff && (params.style === "delta" || params.style === "auto")) {
        const deltaResult = spawnDelta(stdout);
        if (deltaResult.status === 0 && deltaResult.stdout?.trim()) {
          styledDiff = deltaResult.stdout.trim();
          diffStyle = "delta";
          logBinaryUsage(pi, ctx, "delta", true);
        } else {
          logBinaryUsage(pi, ctx, "delta", false);
        }
      }
      // Pure TS fallback: basic syntax highlighting if no binary is available
      if (!styledDiff) {
        styledDiff = highlightDiff(stdout);
        diffStyle = "typescript";
      }
    }

    const outputDetails: Record<string, unknown> = {
      operation: params.operation,
      command: cmd.join(" "),
      exit_code: result.status,
    };

    const contentParts: Array<{ type: string; text: string }> = [];

    // Parse structured output per operation
    if (params.operation === "status" && stdout) {
      const files = stdout.split("\n").map((l) => {
        const status = l.slice(0, 2).trim();
        const file = l.slice(3).trim();
        const staged = l[0] !== " ";
        const unstaged = l[1] !== " ";
        return {
          status,
          file,
          staged: staged && status,
          unstaged: unstaged && l[1] !== " " ? l[1] : undefined,
        };
      });
      outputDetails.files = files;
      outputDetails.staged_count = files.filter((f: any) => f.staged).length;
      outputDetails.unstaged_count = files.filter((f: any) => f.unstaged).length;
      outputDetails.untracked_count = files.filter((f: any) => f.status === "??").length;
      
      contentParts.push({
        type: "text",
        text:
          `**Status:** ${files.filter((f: any) => f.staged).length} staged, ${files.filter((f: any) => f.unstaged).length} unstaged, ${files.filter((f: any) => f.status === "??").length} untracked\n\n` +
          files.map((f: any) => `${f.status} ${f.file}`).join("\n"),
      });
    } else if (params.operation === "diff" && stdout) {
      const lines = stdout.split("\n");
      outputDetails.summary = `${lines.length} lines changed`;
      if (lines.length > 60) {
        outputDetails.diff_head = lines.slice(0, 40).join("\n");
        outputDetails.diff_tail = lines.slice(-20).join("\n");
        outputDetails.diff_truncated = lines.length;
        contentParts.push({
          type: "text",
          text: `**Diff:** ${lines.length} lines changed (truncated)\n\n` + lines.slice(0, 40).join("\n") + "\n...\n" + lines.slice(-20).join("\n"),
        });
      } else {
        outputDetails.diff = stdout;
        contentParts.push({ type: "text", text: `**Diff:**\n\n${stdout}` });
      }
    } else if (params.operation === "log" && stdout) {
      const commits = stdout.split("\n").map((l) => {
        const parts = l.split(" ");
        return { sha: parts[0], message: parts.slice(1).join(" ") };
      });
      outputDetails.commits = commits;
      contentParts.push({
        type: "text",
        text: `**Commits:**\n\n` + commits.map((c: any) => `- ${c.sha.slice(0, 8)} ${c.message}`).join("\n"),
      });
    } else if (params.operation === "rev-parse" && stdout) {
      outputDetails.sha = stdout;
      contentParts.push({ type: "text", text: `**SHA:** ${stdout}` });
    } else if (params.operation === "branch") {
      outputDetails.branch = stdout;
      contentParts.push({ type: "text", text: `**Branch:** ${stdout}` });
    } else if (stdout) {
      const lines = stdout.split("\n");
      if (lines.length > 30) {
        outputDetails.output_head = lines.slice(0, 20).join("\n");
        outputDetails.output_truncated = lines.length;
        contentParts.push({
          type: "text",
          text: `**Output:** (${lines.length} lines, truncated)\n\n` + lines.slice(0, 20).join("\n"),
        });
      } else {
        outputDetails.output = stdout;
        contentParts.push({ type: "text", text: `**Output:**\n\n${stdout}` });
      }
    }

    if (styledDiff) {
      outputDetails.styled_diff = styledDiff.slice(0, 5000);
      outputDetails.diff_style = diffStyle;
    }
    if (stderr) outputDetails.stderr = stderr;
    if (result.error) {
      outputDetails.status = "error";
      outputDetails.error = result.error.message;
      contentParts.push({ type: "text", text: `**Error:** ${result.error.message}` });
    } else {
      outputDetails.status = result.status === 0 ? "success" : "error";
    }

    // Log to analytics
    artifactLog(pi, ctx, {
      tool: "smart_git",
      action: "git_op",
      operation: params.operation,
      exit_code: result.status,
    });

    onUpdate?.({
      content: [{ type: "text", text: `Git ${params.operation} completed with exit code ${result.status}` }],
      details: { phase: "complete", exit_code: result.status },
    });

    return {
      content: contentParts,
      details: outputDetails,
    };
  },
});

export default factory;