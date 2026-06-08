import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { resolve, relative } from "node:path";
import { statSync, readdirSync, readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";

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

// Gitignore parser
function loadGitignore(worktree: string): { ignored: (p: string) => boolean } {
  const patterns: Array<{ pattern: string; negate: boolean }> = [];
  const giPath = r(worktree, ".gitignore");
  if (existsSync(giPath)) {
    try {
      for (const line of readFileSync(giPath, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        patterns.push({
          pattern: trimmed.startsWith("!") ? trimmed.slice(1) : trimmed,
          negate: trimmed.startsWith("!"),
        });
      }
    } catch {
      // Ignore gitignore parse errors
    }
  }
  patterns.push({ pattern: ".git", negate: false });
  return {
    ignored(p: string): boolean {
      let result = false;
      for (const { pattern, negate } of patterns) {
        if (matchGitignore(pattern, p)) result = !negate;
      }
      return result;
    },
  };
}

function matchGitignore(pattern: string, path: string): boolean {
  let re = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "§§R§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§R§§/g, ".*")
    .replace(/\?/g, ".");
  if (!pattern.includes("/") && !pattern.startsWith("**/")) {
    re = "(^|.*/)" + re + "$";
  } else {
    re = "^" + re.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$";
  }
  try {
    return new RegExp(re).test(path);
  } catch {
    return false;
  }
}

function matchGlob(pattern: string, name: string): boolean {
  const globToRegex = (p: string): string => {
    return "^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  };
  try {
    return new RegExp(globToRegex(pattern)).test(name);
  } catch {
    return false;
  }
}

interface WalkEntry {
  path: string;
  relPath: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

function walk(
  dir: string,
  base: string,
  ignored: (p: string) => boolean,
  pattern: string | undefined,
  type: string | undefined,
  maxDepth: number,
  depth: number,
  maxResults: number,
  newerMin: number,
  results: WalkEntry[]
): void {
  if (results.length >= maxResults) return;
  if (maxDepth > 0 && depth > maxDepth) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (results.length >= maxResults) break;
    const full = resolve(dir, name);
    const rel = relative(base, full);

    // Skip gitignored
    if (ignored(rel) || ignored(rel + "/")) continue;

    let isDir = false;
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }

    // Newer-than filter
    if (newerMin > 0) {
      const ageMs = Date.now() - mtimeMs;
      if (ageMs > newerMin * 60000) continue;
    }

    if (isDir) {
      if (type !== "file") {
        if (!pattern || matchGlob(pattern, name)) {
          results.push({ path: full, relPath: rel, isDir: true, size: 0, mtimeMs });
          if (results.length >= maxResults) break;
        }
      }
      walk(full, base, ignored, pattern, type, maxDepth, depth + 1, maxResults, newerMin, results);
    } else {
      if (type !== "directory") {
        if (!pattern || matchGlob(pattern, name)) {
          results.push({ path: full, relPath: rel, isDir: false, size, mtimeMs });
        }
      }
    }
  }
}

const factory: CustomToolFactory = (pi) => ({
  name: "smart_find",
  label: "Smart Find",
  description:
    "Find files and directories. Pure TypeScript - no binary dependency. Respects .gitignore. Returns file info with sizes, modified times, and counts.",

  parameters: pi.zod.object({
    pattern: pi.zod
      .string()
      .optional()
      .describe("Glob pattern (e.g. '*.ts', 'dialog-*'). Supports wildcards."),
    path: pi.zod
      .string()
      .optional()
      .describe("Directory to search. Defaults to workspace root."),
    type: pi.zod
      .string()
      .optional()
      .describe("'file', 'directory', or omit for both"),
    max_depth: pi.zod
      .number()
      .optional()
      .describe("Max directory depth (default unlimited)"),
    max_results: pi.zod
      .number()
      .optional()
      .describe("Max results (default 50)"),
    newer_than_minutes: pi.zod
      .number()
      .optional()
      .describe("Only files modified in last N minutes"),
    include_sizes: pi.zod
      .boolean()
      .optional()
      .describe("Include file sizes in bytes"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("smart_find cancelled");

    onUpdate?.({
      content: [{ type: "text", text: `Finding files matching ${params.pattern || "*"}...` }],
      details: { phase: "start", pattern: params.pattern || "*" },
    });

    const searchPath = params.path ? r(pi.cwd, params.path) : pi.cwd;
    const maxResults = params.max_results ?? 50;
    const maxDepth = params.max_depth ?? 0;
    const newerMin = params.newer_than_minutes ?? 0;
    const includeSizes = params.include_sizes ?? false;

    if (!existsSync(searchPath)) {
      onUpdate?.({
        content: [{ type: "text", text: `Path not found: ${searchPath}` }],
        details: { status: "error", error: "Path not found" },
      });
      return {
        content: [{ type: "text", text: `Path not found: ${searchPath}` }],
        details: { files: [], count: 0, error: `Path not found: ${searchPath}` },
      };
    }

    const gitignore = loadGitignore(pi.cwd);
    const results: WalkEntry[] = [];

    onUpdate?.({
      content: [{ type: "text", text: "Walking directory tree..." }],
      details: { phase: "walk" },
    });

    const startTime = Date.now();
    walk(
      searchPath,
      searchPath,
      gitignore.ignored,
      params.pattern,
      params.type,
      maxDepth,
      0,
      maxResults,
      newerMin,
      results
    );
    const elapsed = Date.now() - startTime;

    const files: Array<Record<string, unknown>> = [];
    const byExt: Record<string, number> = {};
    let dirCount = 0;

    for (const entry of results.slice(0, maxResults)) {
      if (entry.isDir) {
        dirCount++;
        files.push({ path: entry.relPath, type: "directory" });
      } else {
        const ext = entry.relPath.includes(".")
          ? "." + entry.relPath.split(".").pop()!
          : "(no extension)";
        byExt[ext] = (byExt[ext] || 0) + 1;
        const f: Record<string, unknown> = { path: entry.relPath, type: "file" };
        if (includeSizes) f.size_bytes = entry.size;
        if (newerMin > 0) f.modified_seconds_ago = Math.floor((Date.now() - entry.mtimeMs) / 1000);
        files.push(f);
      }
    }

    const outputDetails: Record<string, unknown> = {
      status: "ok",
      files,
      count: files.length,
      total_found: results.length,
      directories_found: dirCount,
      truncated: results.length > maxResults,
      elapsed_ms: elapsed,
      backend: "typescript",
    };
    if (Object.keys(byExt).length > 0) {
      outputDetails.by_extension = Object.fromEntries(
        Object.entries(byExt).sort(([, a], [, b]) => (b as number) - (a as number)).slice(0, 10)
      );
    }

    // Log to analytics
    artifactLog(pi, ctx, {
      tool: "smart_find",
      action: "find",
      pattern: (params.pattern || "*").slice(0, 80),
      path: (params.path || "").slice(0, 80),
      count: files.length,
    });
    analytics(pi, ctx, "smart_find", { pattern: (params.pattern || "*").slice(0, 80), path: (params.path || "").slice(0, 80) });

    onUpdate?.({
      content: [{ type: "text", text: `Found ${files.length} files in ${elapsed}ms` }],
      details: { phase: "complete", count: files.length, elapsed_ms: elapsed },
    });

    return {
      content: [
        {
          type: "text",
          text:
            `**Found ${files.length} results** (${dirCount} directories, ${files.length - dirCount} files) in ${elapsed}ms\n\n` +
            files.slice(0, 20).map((f: any) => `${f.type === "directory" ? "📁" : "📄"} ${f.path}`).join("\n") +
            (files.length > 20 ? `\n\n... and ${files.length - 20} more` : ""),
        },
      ],
      details: outputDetails,
    };
  },
});

export default factory;