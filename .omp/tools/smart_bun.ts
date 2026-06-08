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
  name: "smart_bun",
  label: "Smart Bun",
  description:
    "Run bun operations (typecheck, test, install) and return structured results.",

  parameters: pi.zod.object({
    command: pi.zod
      .string()
      .describe("typecheck | test | install | run | tsgo | tsc | solidjs-test"),
    cwd: pi.zod.string().optional().describe("Working directory"),
    args: pi.zod.string().optional().describe("Additional args"),
    timeout_seconds: pi.zod.number().optional().describe("Timeout in seconds (default 120)"),
    test_pattern: pi.zod.string().optional().describe("Test name pattern"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("smart_bun cancelled");

    onUpdate?.({
      content: [{ type: "text", text: `Running bun ${params.command}...` }],
      details: { phase: "start", command: params.command },
    });

    const cwd = params.cwd ? resolvePath(pi.cwd, params.cwd) : pi.cwd;
    const startTime = Date.now();

    const validCommands: Record<string, string> = {
      typecheck: "run typecheck",
      test: "test",
      install: "install",
      run: "run",
      tsgo: "x tsgo",
      tsc: "x tsc",
      "solidjs-test": "test --conditions=browser",
    };

    const bunCmd = validCommands[params.command];
    if (!bunCmd) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown command: '${params.command}'. Valid: ${Object.keys(validCommands).join(", ")}`,
          },
        ],
        details: { status: "error", error: `Unknown command: '${params.command}'`, valid: Object.keys(validCommands) },
      };
    }

    const cmdArgs = bunCmd.split(/\s+/);
    let shellMode = false;
    let shellCmd = "";

    if (params.command === "test" && params.test_pattern) {
      cmdArgs.push("--test-name-pattern", params.test_pattern);
    }

    if (params.args) {
      if (/[|><&;]/.test(params.args)) {
        shellMode = true;
        const cleanArgs = params.args
          .replace(/^bun\s+(run\s+)?/, "")
          .replace(new RegExp(`^${params.command}\\s*`), "")
          .trim();
        shellCmd = `bun ${bunCmd} ${cleanArgs}`;
      } else {
        cmdArgs.push(...params.args.split(/\s+/).filter(Boolean));
      }
    }

    const timeout = (params.timeout_seconds ?? 120) * 1000;
    onUpdate?.({
      content: [{ type: "text", text: `Executing: bun ${cmdArgs.join(" ")}...` }],
      details: { phase: "execute" },
    });

    const spawnOpts = { cwd, encoding: "utf8" as const, maxBuffer: 1024 * 1024 * 5, timeout };
    const result = shellMode
      ? spawnSync(shellCmd, [], { ...spawnOpts, shell: true })
      : spawnSync("bun", cmdArgs, spawnOpts);

    const elapsed = Date.now() - startTime;
    const stdout = result.stdout?.trim() || "";
    const stderr = result.stderr?.trim() || "";

    const outputDetails: Record<string, unknown> = {
      command: params.command, cwd, elapsed_ms: elapsed, exit_code: result.status,
    };
    const contentParts: Array<{ type: string; text: string }> = [];

    // Typecheck parsing
    if (params.command === "typecheck" && stderr) {
      const errors: Array<Record<string, unknown>> = [];
      const errorRe = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)/;
      for (const line of stderr.split("\n")) {
        const trimmed = line.trim();
        const m = trimmed.match(errorRe);
        if (m) {
          errors.push({ file: m[1], line: parseInt(m[2]), col: parseInt(m[3]), level: m[4], code: m[5], message: m[6] });
        }
      }
      const files = new Set(errors.map((e: any) => e.file));
      outputDetails.error_count = errors.length;
      outputDetails.file_count = files.size;
      if (result.status === 0) {
        outputDetails.status = "PASS";
        contentParts.push({ type: "text", text: "✅ Typecheck passed. No errors." });
      } else if (errors.length > 0) {
        outputDetails.status = "FAIL";
        outputDetails.errors = errors.slice(0, 15).map((e: any) => `${e.file}:${e.line}:${e.col} — ${e.message}`);
        contentParts.push({ type: "text", text: `❌ Typecheck failed: ${errors.length} errors in ${files.size} files` });
      } else {
        outputDetails.status = "TOOL ERROR";
        contentParts.push({ type: "text", text: `💥 Typecheck failed with exit ${result.status}` });
      }
    }
    // Test parsing
    else if (params.command === "test" && stdout) {
      const passMatch = stdout.match(/(\d+)\s+pass/);
      const failMatch = stdout.match(/(\d+)\s+fail/);
      const totalMatch = stdout.match(/(\d+)\s+tests/);
      outputDetails.pass = passMatch ? parseInt(passMatch[1]) : 0;
      outputDetails.fail = failMatch ? parseInt(failMatch[1]) : 0;
      outputDetails.total = totalMatch ? parseInt(totalMatch[1]) : 0;
      if (result.status === 0 && outputDetails.fail === 0) {
        outputDetails.status = "PASS";
        contentParts.push({ type: "text", text: `✅ All ${outputDetails.total || outputDetails.pass || "?"} tests passed` });
      } else if (outputDetails.fail > 0) {
        outputDetails.status = "FAIL";
        contentParts.push({ type: "text", text: `❌ Tests failed: ${outputDetails.pass} pass, ${outputDetails.fail} fail` });
      } else if (result.status !== 0) {
        outputDetails.status = "TOOL ERROR";
        contentParts.push({ type: "text", text: `💥 Test failed with exit ${result.status}` });
      }
    }
    // Other commands
    else {
      outputDetails.status = result.status === 0 ? "OK" : "FAIL";
      if (stdout) outputDetails.output = stdout.slice(0, 500);
      if (stderr) outputDetails.stderr = stderr.slice(0, 300);
      contentParts.push({ type: "text", text: result.status === 0 ? `✅ OK` : `❌ Failed with exit ${result.status}` });
    }

    artifactLog(pi, ctx, { tool: "smart_bun", action: "ran", command: params.command, exit_code: result.status, cwd: params.cwd || "root" });

    onUpdate?.({
      content: [{ type: "text", text: `Bun ${params.command} completed in ${elapsed}ms` }],
      details: { phase: "complete", exit_code: result.status },
    });

    return { content: contentParts, details: outputDetails };
  },
});

export default factory;
