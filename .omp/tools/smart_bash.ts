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
    // Silently fail
  }
}

const factory: CustomToolFactory = (pi) => ({
  name: "smart_bash",
  label: "Smart Bash",
  description:
    "Run a bash command with structured logging and automatic smart-tool rerouting. Prefer smart_bun, smart_git, smart_grep, smart_find, smart_sd, read_source.",

  parameters: pi.zod.object({
    command: pi.zod.string().describe("The bash command to run"),
    cwd: pi.zod.string().optional().describe("Working directory"),
    reason: pi.zod.string().describe("Why you need bash"),
    timeout_seconds: pi.zod.number().optional().describe("Max execution time (default 60)"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("smart_bash cancelled");

    onUpdate?.({
      content: [{ type: "text", text: `Running: ${params.command}` }],
      details: { phase: "start", command: params.command, reason: params.reason },
    });

    let cwd = params.cwd ? resolvePath(pi.cwd, params.cwd) : pi.cwd;
    let cmd = params.command.trim();

    // Block destructive commands
    const destructive = ["rm -rf", "git push --force", "git reset --hard", "git clean -f", "git branch -D", ":(){ :|:& }:"];
    if (destructive.some((d) => cmd.includes(d))) {
      onUpdate?.({
        content: [{ type: "text", text: "Destructive command blocked" }],
        details: { phase: "blocked", reason: "Destructive command" },
      });
      return {
        content: [{ type: "text", text: "Destructive command blocked" }],
        details: { status: "blocked", error: "Destructive command blocked", command: cmd.slice(0, 100) },
      };
    }

    // Auto-detect cd prefix
    const cdMatch = cmd.match(/^cd\s+(\S+)\s*(?:&&|;)\s*(.+)/);
    if (cdMatch) {
      const cdDir = cdMatch[1];
      const rest = cdMatch[2].trim();
      const nestedCd = rest.match(/^cd\s+(\S+)\s*(?:&&|;)\s*(.+)/);
      if (nestedCd) {
        return {
          content: [
            {
              type: "text",
              text: `Use the cwd parameter instead of cd. Example: cwd: '${cdDir}', command: '${nestedCd[2].trim().slice(0, 80)}'`,
            },
          ],
          details: { status: "hint", hint: "Use cwd parameter", original: cmd.slice(0, 100) },
        };
      }
      cwd = cdDir ? resolvePath(pi.cwd, cdDir) : cwd;
      cmd = rest;
    }

    const binary = cmd.split(/\s+/)[0];

    // Rerouting table: bash binary -> smart tool
    const reroutes: Record<string, { tool: string; extract: (parts: string[]) => Record<string, string> | null }> = {
      rg:   { tool: "smart_grep",  extract: (p) => { const a = p.filter(x => !x.startsWith("-")); if (a.length < 2) return null; return { pattern: a[0]!, path: a.slice(1).join(" ") } } },
      grep: { tool: "smart_grep",  extract: (p) => { const a = p.filter(x => !x.startsWith("-")); if (a.length < 2) return null; return { pattern: a[0]!, path: a.slice(1).join(" ") } } },
      fd:   { tool: "smart_find",  extract: (p) => { const a = p.filter(x => !x.startsWith("-")); return { pattern: a[a.length-1] || "*", path: a.length > 1 ? a[0] : "." } } },
      find: { tool: "smart_find",  extract: (p) => { const a = p.filter(x => !x.startsWith("-")); return { pattern: a[a.length-1] || "*", path: a.length > 1 ? a[0] : "." } } },
      ls:   { tool: "smart_find",  extract: (p) => { const a = p.filter(x => !x.startsWith("-")); return { pattern: "*", path: a[0] || "." } } },
      cat:  { tool: "read_source", extract: (p) => { const a = p.filter(x => !x.startsWith("-")); if (a.length === 0) return null; return { file: a.join(" ") } } },
      bat:  { tool: "read_source", extract: (p) => { const a = p.filter(x => !x.startsWith("-")); if (a.length === 0) return null; return { file: a.join(" ") } } },
      git:  { tool: "smart_git",   extract: (p) => { const ops = ["status","diff","add","commit","push","log","branch","rev-parse","stash","checkout","show"]; const effective = p[0] === "-C" ? p.slice(2) : p; const op = (effective[0]||"").replace("--",""); return ops.includes(op) ? { operation: op, args: effective.slice(1).join(" ") } : null } },
      bun:  { tool: "smart_bun",   extract: (p) => { const sub = p[0] === "run" ? p[1] : p[0]; return ["typecheck","test","install","run","tsgo","tsc"].includes(sub) ? { command: sub, args: p.slice(sub === "run" ? 2 : 1).join(" ") || undefined } : null } },
      sd:   { tool: "smart_sd",    extract: (p) => { const a = p.filter(x => !x.startsWith("-")); if (a.length < 3) return null; return { file: a[a.length-1]!, old: a[0]!, new: a[1]!, reason: params.reason } } },
      sed:  { tool: "smart_sd",    extract: (p) => { const a = p.filter(x => !x.startsWith("-") && !x.startsWith("'")); if (a.length < 2) return null; const file = a[a.length-1]!; const expr = a[0]!; const sMatch = expr.match(/^s([^a-z]).*\1.*\1/); if (!sMatch) return null; return { file, old: expr, new: "", reason: params.reason } } },
    };

    const r = reroutes[binary];
    if (r) {
      const parts = cmd.split(/\s+/).slice(1);
      const paramsForTool = r.extract(parts);
      if (paramsForTool) {
        onUpdate?.({
          content: [{ type: "text", text: `Rerouted to ${r.tool}` }],
          details: { phase: "rerouted", to: r.tool },
        });
        return {
          content: [
            {
              type: "text",
              text: `Rerouted to ${r.tool}. Call ${r.tool} directly next time — it's faster and returns structured output.`,
            },
          ],
          details: { status: "rerouted", original: cmd.slice(0, 100), to: r.tool, params: paramsForTool, hint: `Rerouted to ${r.tool}` },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Could not convert '${binary}' command to ${r.tool} format. Running as raw bash.`,
          },
        ],
        details: { status: "reroute_failed", original: cmd.slice(0, 100), binary, hint: `Consider calling ${r.tool} directly` },
      };
    }

    // Rust replacement: swap cat->bat, ls->eza
    let actualCmd = params.command;
    if (binary === "cat" && !r) actualCmd = params.command.replace(/^cat\b/, "bat --paging=never");
    if (binary === "ls" && !r) {
      if (params.command.includes("-l")) actualCmd = params.command.replace(/^ls\b/, "eza -l --group-directories-first");
      else if (params.command.includes("-a") || params.command.includes("-A")) actualCmd = params.command.replace(/^ls\b/, "eza -a --group-directories-first");
      else if (params.command.includes("-R") || params.command.includes("-r")) actualCmd = params.command.replace(/^ls\b/, "eza -R --group-directories-first");
      else actualCmd = params.command.replace(/^ls\b/, "eza --group-directories-first");
    }

    const timeout = (params.timeout_seconds ?? 60) * 1000;
    const startTime = Date.now();
    const result = spawnSync(actualCmd, [], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 2, timeout, shell: true });
    const elapsed = Date.now() - startTime;
    const stdout = (result.stdout || "").trim();
    const stderr = (result.stderr || "").trim();

    const outputDetails: Record<string, unknown> = { status: result.status === 0 ? "pass" : "fail", command: actualCmd.slice(0, 200), elapsed_ms: elapsed };
    const contentParts: Array<{ type: string; text: string }> = [];

    const lines = stdout.split("\n");
    if (lines.length > 40) {
      outputDetails.head = lines.slice(0, 20).join("\n");
      outputDetails.tail = lines.slice(-20).join("\n");
      outputDetails.truncated = lines.length;
      contentParts.push({ type: "text", text: `Output truncated (${lines.length} lines):\n` + lines.slice(0, 20).join("\n") + "\n...\n" + lines.slice(-20).join("\n") });
    } else if (stdout) {
      outputDetails.stdout = stdout;
      contentParts.push({ type: "text", text: stdout });
    }
    if (stderr) outputDetails.stderr = stderr.slice(0, 500);
    if (result.error) { outputDetails.status = "error"; outputDetails.error = result.error.message; contentParts.push({ type: "text", text: `Error: ${result.error.message}` }); }

    artifactLog(pi, ctx, { tool: "smart_bash", action: "bash", command: cmd.slice(0, 100), exit_code: result.status });

    onUpdate?.({
      content: [{ type: "text", text: `Bash completed with exit ${result.status}` }],
      details: { phase: "complete", exit_code: result.status },
    });

    return { content: contentParts, details: outputDetails };
  },
});

export default factory;
