import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { resolve, relative } from "node:path";
import { readdirSync, readFileSync, statSync, appendFileSync, existsSync, mkdirSync } from "node:fs";

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
      // Ignore
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

function collectFiles(
  dir: string,
  base: string,
  ignored: (p: string) => boolean,
  glob: string | undefined,
  maxResults: number,
  results: string[]
): void {
  if (results.length >= maxResults) return;

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

    if (ignored(rel) || ignored(rel + "/")) continue;

    let isDir = false;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      collectFiles(full, base, ignored, glob, maxResults, results);
    } else {
      if (!glob || matchGlob(glob, name)) {
        results.push(full);
      }
    }
  }
}

function isTextFile(path: string): boolean {
  try {
    const buf = readFileSync(path, { length: 512 });
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const factory: CustomToolFactory = (pi) => ({
  name: "smart_grep",
  label: "Smart Grep",
  description:
    "Search for patterns in files. Pure TypeScript - no binary dependency. Returns structured file:line:match results. Respects .gitignore.",

  parameters: pi.zod.object({
    pattern: pi.zod.string().describe("Pattern to search for (regex or literal)"),
    path: pi.zod.string().optional().describe("Directory or file to search. Defaults to workspace root."),
    glob: pi.zod.string().optional().describe("File glob pattern (e.g. '*.ts', '*.md')"),
    max_results: pi.zod.number().optional().describe("Max results (default 30)"),
    summary_only: pi.zod.boolean().optional().describe("Return only file paths + match counts"),
    context_lines: pi.zod.number().optional().describe("Lines of context around each match (default 0)"),
    word_boundary: pi.zod.boolean().optional().describe("Match whole words only"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("smart_grep cancelled");

    onUpdate?.({
      content: [{ type: "text", text: `Searching for pattern: ${params.pattern}` }],
      details: { phase: "start", pattern: params.pattern },
    });

    const searchPath = params.path ? r(pi.cwd, params.path) : pi.cwd;
    const maxResults = params.max_results ?? 30;
    const summaryOnly = params.summary_only ?? false;

    if (!existsSync(searchPath)) {
      onUpdate?.({
        content: [{ type: "text", text: `Path not found: ${searchPath}` }],
        details: { status: "error", error: "Path not found" },
      });
      return {
        content: [{ type: "text", text: `Path not found: ${searchPath}` }],
        details: { matches: [], count: 0, error: `Path not found: ${searchPath}` },
      };
    }

    // Build regex
    let regex: RegExp;
    try {
      const p = params.word_boundary ? `\\b${params.pattern}\\b` : params.pattern;
      regex = new RegExp(p, "g");
    } catch {
      return {
        content: [{ type: "text", text: `Invalid regex pattern: ${params.pattern}` }],
        details: { status: "error", error: `Invalid regex: ${params.pattern}` },
      };
    }

    onUpdate?.({
      content: [{ type: "text", text: "Collecting files..." }],
      details: { phase: "collect" },
    });

    // Collect files
    const gitignore = loadGitignore(pi.cwd);
    const files: string[] = [];

    const startTime = Date.now();
    const st = statSync(searchPath);
    if (st.isFile()) {
      if (isTextFile(searchPath)) files.push(searchPath);
    } else {
      collectFiles(searchPath, searchPath, gitignore.ignored, params.glob, 500, files);
    }

    onUpdate?.({
      content: [{ type: "text", text: `Searching ${files.length} files...` }],
      details: { phase: "search", file_count: files.length },
    });

    // Search files
    const matches: Array<{ file: string; line: number; col: number | undefined; text: string }> = [];
    const fileCounts: Record<string, number> = {};
    let totalHits = 0;
    let searchedFiles = 0;

    for (const file of files) {
      if (matches.length >= maxResults && !summaryOnly) break;
      if (!isTextFile(file)) continue;
      searchedFiles++;

      try {
        const content = readFileSync(file, "utf8");
        const lines = content.split("\n");
        const relPath = relative(pi.cwd, file);
        let fileHits = 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          regex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(line)) !== null) {
            totalHits++;
            fileHits++;
            const text = line.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim();
            if (!summaryOnly && matches.length < maxResults) {
              matches.push({ file: relPath, line: i + 1, col: m.index + 1, text: text.slice(0, 200) });
            }
            if (matches.length >= maxResults && !summaryOnly) break;
          }
          if (matches.length >= maxResults && !summaryOnly) break;
        }

        if (fileHits > 0) fileCounts[relPath] = fileHits;
      } catch {
        // Skip files that can't be read
      }
    }

    const elapsed = Date.now() - startTime;

    // Build output
    if (totalHits === 0) {
      artifactLog(pi, ctx, {
        tool: "smart_grep",
        action: "grep",
        pattern: params.pattern.slice(0, 100),
        path: (params.path || "").slice(0, 80),
        matches: 0,
        files_searched: searchedFiles,
      });
      analytics(pi, ctx, "smart_grep", { pattern: params.pattern.slice(0, 100), path: (params.path || "").slice(0, 80) });

      onUpdate?.({
        content: [{ type: "text", text: `No matches found in ${searchedFiles} files` }],
        details: { phase: "complete", matches: 0, files: searchedFiles },
      });

      return {
        content: [{ type: "text", text: `🔍 NO MATCHES: Pattern '${params.pattern}' not found in ${searchedFiles} files. Try a different pattern or check the path.` }],
        details: {
          status: "NO MATCHES",
          pattern: params.pattern,
          searched: `${searchedFiles} files`,
          elapsed_ms: elapsed,
        },
      };
    }

    if (summaryOnly) {
      artifactLog(pi, ctx, {
        tool: "smart_grep",
        action: "grep",
        pattern: params.pattern.slice(0, 100),
        path: (params.path || "").slice(0, 80),
        total_matches: totalHits,
        files_with_matches: Object.keys(fileCounts).length,
      });
      analytics(pi, ctx, "smart_grep", { pattern: params.pattern.slice(0, 100), path: (params.path || "").slice(0, 80) });

      onUpdate?.({
        content: [{ type: "text", text: `Found ${totalHits} matches in ${Object.keys(fileCounts).length} files` }],
        details: { phase: "complete", matches: totalHits, files: Object.keys(fileCounts).length },
      });

      return {
        content: [
          {
            type: "text",
            text: `✅ ${totalHits} matches in ${Object.keys(fileCounts).length} files\n\n` +
                  Object.entries(fileCounts)
                    .sort(([, a], [, b]) => (b as number) - (a as number))
                    .slice(0, 20)
                    .map(([file, cnt]) => `  ${file} (${cnt})`)
                    .join("\n"),
          },
        ],
        details: {
          status: `Found ${totalHits} matches`,
          pattern: params.pattern,
          elapsed_ms: elapsed,
          files: Object.entries(fileCounts)
            .sort(([, a], [, b]) => (b as number) - (a as number))
            .slice(0, 20)
            .map(([file, cnt]) => `${file} (${cnt})`),
        },
      };
    }

    artifactLog(pi, ctx, {
      tool: "smart_grep",
      action: "grep",
      pattern: params.pattern.slice(0, 100),
      path: (params.path || "").slice(0, 80),
      total_matches: totalHits,
      matches_shown: matches.length,
      files_with_matches: Object.keys(fileCounts).length,
    });
    analytics(pi, ctx, "smart_grep", { pattern: params.pattern.slice(0, 100), path: (params.path || "").slice(0, 80) });

    onUpdate?.({
      content: [{ type: "text", text: `Found ${matches.length} matches (${totalHits} total)` }],
      details: { phase: "complete", matches: matches.length, total: totalHits },
    });

    return {
      content: [
        {
          type: "text",
          text: `✅ ${matches.length} matches shown (${totalHits} total in ${Object.keys(fileCounts).length} files)\n\n` +
                matches.map((m) => `${m.file}:${m.line} — ${m.text}`).join("\n") +
                (totalHits > maxResults ? `\n\n... and ${totalHits - matches.length} more matches not shown` : ""),
        },
      ],
      details: {
        status: `Found ${matches.length} matches`,
        pattern: params.pattern,
        elapsed_ms: elapsed,
        total_matches: totalHits,
        matches: matches.map((m) => `${m.file}:${m.line} — ${m.text}`),
        truncated: totalHits > maxResults ? `${totalHits - matches.length} more not shown` : undefined,
      },
    };
  },
});

export default factory;
