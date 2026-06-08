import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";

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

const factory: CustomToolFactory = (pi) => ({
  name: "smart_session",
  label: "Smart Session",
  description:
    "Session lifecycle manager - init, search, suggest, diff, end. One tool for everything session-related.",

  parameters: pi.zod.object({
    action: pi.zod.string().describe("init | search | suggest | diff | end | curate"),
    query: pi.zod.string().optional().describe("Search query (for search action)"),
    file: pi.zod.string().optional().describe("File filter (for search/diff actions)"),
    agent: pi.zod.string().optional().describe("Agent filter (for search action)"),
    roadmap_item: pi.zod.string().optional().describe("Roadmap item filter (for search action)"),
    summary: pi.zod.string().optional().describe("Session summary (for end action)"),
    limit: pi.zod.number().optional().describe("Max results (default 5 for suggest, 10 for search)"),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    if (signal?.aborted) throw new Error("smart_session cancelled");

    const sessionId = ctx.sessionId || "unknown";
    const base = r(pi.cwd, "docs/json/omp");
    const sessionDir = r(base, "sessions", sessionId);

    onUpdate?.({
      content: [{ type: "text", text: `Session action: ${params.action}` }],
      details: { phase: "start", action: params.action },
    });

    // INIT
    if (params.action === "init") {
      // Check for unfinished previous session
      const archiveDir = r(base, "archive");
      let recovery: Record<string, unknown> | null = null;
      if (existsSync(archiveDir)) {
        try {
          const archives = readdirSync(archiveDir).filter((f) => f.endsWith(".v1.json") && !f.startsWith("."));
          if (archives.length > 0) {
            const lastArchive = archives.sort().pop()!;
            const archived = JSON.parse(readFileSync(r(archiveDir, lastArchive), "utf8"));
            if (!archived.summary || archived.summary === "null") {
              recovery = {
                previous_session: archived.session_id,
                agents_involved: archived.agents_involved,
                files_touched: archived.files_touched,
                status: "unfinished - no summary found. Previous session may have crashed.",
                resume_hint: "Re-delegate the lanes that were in progress.",
              };
            }
          }
        } catch {
          // Ignore
        }
      }

      // Check Rust tools
      const rustTools: Record<string, boolean> = {};
      for (const t of ["rg", "fd", "bat", "eza", "delta"]) {
        const result = spawnSync("which", [t], { encoding: "utf8", timeout: 3000 });
        rustTools[t] = result.status === 0;
      }
      const missing = Object.entries(rustTools).filter(([, ok]) => !ok).map(([t]) => t);

      // Read roadmap
      const roadmapPath = r(base, "roadmaps/active.v1.json");
      let nextItems: Array<Record<string, unknown>> = [];
      if (existsSync(roadmapPath)) {
        try {
          const active = JSON.parse(readFileSync(roadmapPath, "utf8"));
          const completed = new Set(
            (active.items || [])
              .filter((i: any) => i.status === "completed" || i.completion_pct >= 100)
              .map((i: any) => i.id)
          );
          nextItems = (active.items || [])
            .filter((i: any) => i.status !== "completed" && i.status !== "deprecated" && i.completion_pct < 100)
            .filter((i: any) => !(i.depends_on || []).some((d: string) => !completed.has(d)))
            .sort((a: any, b: any) => (a.priority || 99) - (b.priority || 99))
            .slice(0, 5);
        } catch {
          // Ignore
        }
      }

      onUpdate?.({
        content: [{ type: "text", text: "Session initialized" }],
        details: { phase: "complete", action: "init" },
      });

      return {
        content: [
          {
            type: "text",
            text: `Session initialized.\n\n` +
                  (recovery ? `**Recovery:** Previous session ${recovery.previous_session} was unfinished. ${recovery.resume_hint}\n\n` : "") +
                  `**Environment:** ${missing.length > 0 ? `Missing tools: ${missing.join(", ")}. Install with: brew install ${missing.join(" ")}` : "All Rust tools available"}\n\n` +
                  (nextItems.length > 0 ? `**Next Roadmap Item:** ${nextItems[0].id} - ${nextItems[0].title}\n${nextItems[0].next_step}` : "No roadmap items ready."),
          },
        ],
        details: {
          action: "init",
          roadmap: nextItems.map((i: any) => ({
            id: i.id,
            title: i.title,
            phase: i.phase,
            next_step: i.next_step,
          })),
          environment: {
            rust_tools: rustTools,
            missing,
            hint: missing.length ? `brew install ${missing.join(" ")}` : "All tools available",
          },
          recommendation: nextItems[0] ? `Delegate: ${nextItems[0].id} — ${nextItems[0].title}` : "Use suggest for guidance.",
        },
      };
    }

    // SEARCH
    if (params.action === "search") {
      const archivePath = r(base, "archive/sessions.v1.jsonl");
      if (!existsSync(archivePath)) {
        return {
          content: [{ type: "text", text: "No session archive found." }],
          details: { action: "search", results: [], hint: "No archive yet." },
        };
      }

      let entries: Array<Record<string, unknown>> = [];
      try {
        entries = readFileSync(archivePath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .filter(Boolean) as Array<Record<string, unknown>>;
      } catch {
        return {
          content: [{ type: "text", text: "Archive corrupted" }],
          details: { action: "search", results: [], error: "Archive corrupted" },
        };
      }

      const limit = params.limit ?? 10;
      let filtered = entries;
      if (params.file) {
        filtered = filtered.filter((e) => (e.files_touched as string[] | undefined)?.some((f) => f.includes(params.file!)));
      }
      if (params.agent) {
        filtered = filtered.filter((e) => (e.agents_involved as string[] | undefined)?.some((a) => a.includes(params.agent!)));
      }
      if (params.roadmap_item) {
        filtered = filtered.filter((e) => (e.roadmap_items_touched as Array<{ id: string }> | undefined)?.some((r) => r.id === params.roadmap_item));
      }
      if (params.query) {
        const q = params.query.toLowerCase();
        filtered = filtered.filter((e) => JSON.stringify(e).toLowerCase().includes(q));
      }

      filtered.sort((a, b) => (b.archived_at as string || "").localeCompare(a.archived_at as string || ""));

      onUpdate?.({
        content: [{ type: "text", text: `Found ${filtered.length} sessions` }],
        details: { phase: "complete", action: "search", count: filtered.length },
      });

      return {
        content: [
          {
            type: "text",
            text: `Found ${filtered.length} sessions (showing ${Math.min(filtered.length, limit)})\n\n` +
                  filtered.slice(0, limit).map((e: any) =>
                    `- **${e.session_id?.slice(0, 16)}** (${e.archived_at?.slice(0, 19)})\n  ${e.summary?.slice(0, 100) || "No summary"}\n  ${e.files_touched?.length || 0} files, ${e.friction_entries || 0} friction, ${e.tool_failures || 0} failures`
                  ).join("\n\n"),
          },
        ],
        details: {
          action: "search",
          results: filtered.slice(0, limit).map((e: any) => ({
            session: e.session_id?.slice(0, 16),
            archived: e.archived_at?.slice(0, 19),
            summary: e.summary?.slice(0, 150),
            files: (e.files_touched as string[] | undefined)?.length || 0,
            friction: e.friction_entries || 0,
            failures: e.tool_failures || 0,
          })),
          total: filtered.length,
        },
      };
    }

    // SUGGEST
    if (params.action === "suggest") {
      const limit = params.limit ?? 5;
      const suggestions: Array<Record<string, unknown>> = [];

      // Read lessons
      const lessons: Array<Record<string, unknown>> = [];
      const lp = r(base, "knowledge/lessons.v1.jsonl");
      if (existsSync(lp)) {
        try {
          lessons.push(
            ...readFileSync(lp, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((l) => {
                try {
                  return JSON.parse(l) as Record<string, unknown>;
                } catch {
                  return null;
                }
              })
              .filter(Boolean) as Array<Record<string, unknown>>
          );
        } catch {
          // Ignore
        }
      }

      // Read friction
      const frictionItems: Array<Record<string, unknown>> = [];
      const sessionsDir = r(base, "sessions");
      if (existsSync(sessionsDir)) {
        for (const dir of readdirSync(sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
          const fp = r(sessionsDir, dir.name, "feedback/friction.v1.jsonl");
          if (!existsSync(fp)) continue;
          try {
            for (const line of readFileSync(fp, "utf8").split("\n").filter(Boolean)) {
              try {
                frictionItems.push({ ...JSON.parse(line), session: dir.name.slice(0, 16) });
              } catch {
                // Ignore
              }
            }
          } catch {
            // Ignore
          }
        }
      }

      // Read findings
      const findings: Array<Record<string, unknown>> = [];
      const fip = r(base, "knowledge/findings.v1.jsonl");
      if (existsSync(fip)) {
        try {
          findings.push(
            ...readFileSync(fip, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((l) => {
                try {
                  return JSON.parse(l) as Record<string, unknown>;
                } catch {
                  return null;
                }
              })
              .filter(Boolean) as Array<Record<string, unknown>>
          );
        } catch {
          // Ignore
        }
      }

      // Roadmap
      const roadmap: Array<Record<string, unknown>> = [];
      const rp = r(base, "roadmaps/active.v1.json");
      if (existsSync(rp)) {
        try {
          roadmap.push(...(JSON.parse(readFileSync(rp, "utf8")).items || []));
        } catch {
          // Ignore
        }
      }

      const completed = new Set(roadmap.filter((i: any) => i.status === "completed" || i.completion_pct >= 100).map((i: any) => i.id));
      const ready = roadmap
        .filter((i: any) => i.status !== "completed" && i.status !== "deprecated")
        .filter((i: any) => !(i.depends_on || []).some((d: string) => !completed.has(d)))
        .sort((a: any, b: any) => (a.priority || 99) - (b.priority || 99));

      for (const item of ready.slice(0, limit)) {
        const relLessons = lessons.filter(
          (l) =>
            (item.title as string | undefined)?.toLowerCase().includes((l.pattern as string | undefined)?.toLowerCase() || "") ||
            (l.lesson as string | undefined)?.toLowerCase().includes((item.title as string | undefined)?.toLowerCase() || "")
        );
        const relFriction = frictionItems.filter((f) => (f.note as string | undefined)?.toLowerCase().includes((item.title as string | undefined)?.toLowerCase()?.slice(0, 20) || ""));
        suggestions.push({
          type: "roadmap",
          priority: item.priority || 99,
          item_id: item.id,
          title: item.title,
          next_step: item.next_step,
          context: (item.context_summary as string | undefined)?.slice(0, 200),
          lessons: relLessons.slice(0, 2).map((l) => l.lesson),
          friction_count: relFriction.length,
          recommendation: relFriction.length > 0 ? `WARNING: ${relFriction.length} friction reports. Review first.` : "No prior friction.",
        });
      }

      // Recurring friction
      const byPattern: Record<string, { count: number; sessions: Set<string> }> = {};
      for (const f of frictionItems) {
        const key = (f.note as string | undefined)?.slice(0, 80) || "?";
        if (!byPattern[key]) byPattern[key] = { count: 0, sessions: new Set() };
        byPattern[key].count++;
        byPattern[key].sessions.add(f.session as string || "");
      }
      for (const [pattern, data] of Object.entries(byPattern)
        .filter(([, v]) => v.count >= 2)
        .sort(([, a], [, b]) => b.count - a.count)
        .slice(0, 3)) {
        suggestions.push({
          type: "friction_fix",
          priority: 0,
          pattern: pattern.slice(0, 100),
          occurrences: data.count,
          across_sessions: data.sessions.size,
          recommendation: `Recurring (${data.count}x). Fix root cause.`,
        });
      }

      // Unfixed bugs
      for (const b of findings.filter((f: any) => f.finding_type === "bug" && f.status !== "fixed").slice(0, 3)) {
        suggestions.push({
          type: "unfixed_bug",
          priority: 1,
          summary: b.summary,
          file: b.file,
          recommendation: `Unfixed: ${(b.summary as string | undefined)?.slice(0, 100)}`,
        });
      }

      suggestions.sort((a, b) => (a.priority as number || 99) - (b.priority as number || 99));

      onUpdate?.({
        content: [{ type: "text", text: `Found ${suggestions.length} suggestions` }],
        details: { phase: "complete", action: "suggest", count: suggestions.length },
      });

      return {
        content: [
          {
            type: "text",
            text: `Suggestions (${suggestions.length})\n\n` +
                  suggestions.slice(0, limit).map((s: any) =>
                    `**${s.type}** (priority: ${s.priority})\n` +
                    (s.title ? `  Title: ${s.title}\n` : "") +
                    (s.item_id ? `  Item: ${s.item_id}\n` : "") +
                    (s.pattern ? `  Pattern: ${s.pattern}\n` : "") +
                    (s.summary ? `  Summary: ${s.summary}\n` : "") +
                    `  ${s.recommendation}`
                  ).join("\n\n"),
          },
        ],
        details: {
          action: "suggest",
          suggestions: suggestions.slice(0, limit),
          summary: {
            roadmap_ready: ready.length,
            recurring_friction: Object.values(byPattern).filter((v) => v.count >= 2).length,
            unfixed_bugs: findings.filter((f: any) => f.finding_type === "bug" && f.status !== "fixed").length,
            lessons: lessons.length,
          },
        },
      };
    }

    // DIFF
    if (params.action === "diff") {
      const editLogPath = r(sessionDir, "edits/edit_log.v1.jsonl");
      const filesCreated = new Set<string>();
      const filesModified = new Set<string>();
      let totalEdits = 0;

      if (existsSync(editLogPath)) {
        try {
          for (const line of readFileSync(editLogPath, "utf8").split("\n").filter(Boolean)) {
            try {
              const e = JSON.parse(line) as Record<string, unknown>;
              totalEdits++;
              const fp = e.file as string || "";
              if ((e.change_summary as string | undefined)?.includes("create") || (e.action as string | undefined) === "create") {
                filesCreated.add(fp);
              } else {
                filesModified.add(fp);
              }
            } catch {
              // Ignore
            }
          }
        } catch {
          // Ignore
        }
      }

      // Git fallback
      if (totalEdits === 0) {
        try {
          const result = spawnSync("git", ["diff", "--name-status", "HEAD"], { encoding: "utf8", timeout: 10000 });
          if (result.status === 0 && result.stdout?.trim()) {
            for (const line of result.stdout.trim().split("\n")) {
              const parts = line.split("\t");
              if (parts.length < 2) continue;
              if (parts[0]!.startsWith("A")) filesCreated.add(parts[1]!);
              else filesModified.add(parts[1]!);
              totalEdits++;
            }
          }
        } catch {
          // Ignore
        }
      }

      let netLines = "+0/-0";
      try {
        const result = spawnSync("git", ["diff", "--stat", "HEAD"], { encoding: "utf8", timeout: 10000 });
        if (result.status === 0 && result.stdout?.trim()) {
          netLines = result.stdout.trim().split("\n").pop()!.trim();
        }
      } catch {
        // Ignore
      }

      onUpdate?.({
        content: [{ type: "text", text: `Diff: ${filesCreated.size} created, ${filesModified.size} modified` }],
        details: { phase: "complete", action: "diff", created: filesCreated.size, modified: filesModified.size },
      });

      return {
        content: [
          {
            type: "text",
            text: `**Session Diff**\n\n` +
                  `Files created: ${filesCreated.size}\n` +
                  `Files modified: ${filesModified.size}\n` +
                  `Total edits: ${totalEdits}\n` +
                  `Net lines: ${netLines}\n\n` +
                  (filesCreated.size > 0 ? `Created:\n${[...filesCreated].sort().map((f) => `  ${f}`).join("\n")}\n\n` : "") +
                  (filesModified.size > 0 ? `Modified:\n${[...filesModified].sort().map((f) => `  ${f}`).join("\n")}` : ""),
          },
        ],
        details: {
          action: "diff",
          files_created: filesCreated.size,
          files_modified: filesModified.size,
          total_edits: totalEdits,
          net_lines: netLines,
          created: [...filesCreated].sort(),
          modified: [...filesModified].sort(),
        },
      };
    }

    // END
    if (params.action === "end") {
      // Consolidate fragments
      let consolidation: Record<string, unknown> | null = null;
      const fragDir = r(sessionDir, "fragments");
      if (existsSync(fragDir)) {
        try {
          const fragments = readdirSync(fragDir).filter((f) => f.endsWith(".json"));
          if (fragments.length > 0) {
            const byFile: Record<string, string[]> = {};
            for (const f of fragments) {
              try {
                const frag = JSON.parse(readFileSync(r(fragDir, f), "utf8")) as Record<string, unknown>;
                const target = frag.target_file as string || "unknown";
                if (!byFile[target]) byFile[target] = [];
                byFile[target].push(frag.lane_id as string || f);
              } catch {
                // Ignore
              }
            }
            consolidation = {
              fragments_found: fragments.length,
              files: Object.keys(byFile).length,
              note: "Fragments consolidated automatically.",
            };
            for (const [target, lanes] of Object.entries(byFile)) {
              const targetPath = r(pi.cwd, target);
              let merged = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
              for (const lane of lanes) {
                const fragFile = r(fragDir, `${lane}.v1.json`);
                if (existsSync(fragFile)) {
                  try {
                    const frag = JSON.parse(readFileSync(fragFile, "utf8")) as Record<string, unknown>;
                    if (frag.content) {
                      merged += `\n// --- ${lane} ---\n${frag.content}`;
                    }
                  } catch {
                    // Ignore
                  }
                }
              }
              if (merged) writeFileSync(targetPath, merged, "utf8");
            }
          }
        } catch {
          // Ignore
        }
      }

      const archivePath = r(base, "archive/sessions.v1.jsonl");
      try {
        mkdirSync(r(base, "archive"), { recursive: true });
      } catch {
        // Ignore
      }

      const highlights: Record<string, unknown> = {
        schema: "v1",
        session_id: sessionId,
        archived_at: new Date().toISOString(),
        summary: params.summary || null,
      };

      // Artifact
      const artPath = r(sessionDir, "artifacts", `${sessionId}.v1.json`);
      if (existsSync(artPath)) {
        try {
          const a = JSON.parse(readFileSync(artPath, "utf8")) as Record<string, unknown>;
          highlights.tools_used = a.tools_used;
          highlights.files_touched = a.files_touched;
          highlights.total_events = a.total_events;
        } catch {
          // Ignore
        }
      }

      // Friction
      const frictionPath = r(sessionDir, "feedback/friction.v1.jsonl");
      if (existsSync(frictionPath)) {
        try {
          const fe = readFileSync(frictionPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l) as Record<string, unknown>;
              } catch {
                return null;
              }
            })
            .filter(Boolean) as Array<Record<string, unknown>>;
          highlights.friction_entries = fe.length;
          highlights.friction_summary = fe.slice(0, 3).map((e) => (e.note as string | undefined)?.slice(0, 120));
        } catch {
          // Ignore
        }
      }

      // Heartbeat
      const hbPath = r(sessionDir, "analytics/heartbeat.v1.jsonl");
      if (existsSync(hbPath)) {
        try {
          const lines = readFileSync(hbPath, "utf8").split("\n").filter(Boolean);
          const agents = new Set<string>();
          let failures = 0;
          for (const line of lines) {
            try {
              const hb = JSON.parse(line) as Record<string, unknown>;
              agents.add(hb.agent as string || "");
              if (hb.phase === "failed") failures++;
            } catch {
              // Ignore
            }
          }
          highlights.agents_involved = [...agents];
          highlights.tool_calls = lines.length;
          highlights.tool_failures = failures;
        } catch {
          // Ignore
        }
      }

      appendFileSync(archivePath, JSON.stringify(highlights) + "\n", "utf8");
      writeFileSync(r(base, "archive", `${sessionId}.v1.json`), JSON.stringify(highlights, null, 2), "utf8");

      onUpdate?.({
        content: [{ type: "text", text: "Session archived" }],
        details: { phase: "complete", action: "end", session: sessionId },
      });

      return {
        content: [
          {
            type: "text",
            text: `✅ Session ${sessionId} archived.\n\n` +
                  (consolidation ? `Fragments: ${consolidation.fragments_found} consolidated across ${consolidation.files} files.\n\n` : "") +
                  `Use smart_session(action='search') to find past sessions.`,
          },
        ],
        details: {
          action: "end",
          status: "archived",
          session: sessionId,
          highlights,
        },
      };
    }

    // CURATE
    if (params.action === "curate") {
      const ctxDir = r(pi.cwd, `docs/json/omp/sessions/${sessionId}/context`);
      const ctxPath = r(ctxDir, "current.v1.json");
      try {
        mkdirSync(ctxDir, { recursive: true });
      } catch {
        // Ignore
      }
      let existing: Record<string, unknown> = { schema_version: "v1", entries: [], curated_at: null };
      if (existsSync(ctxPath)) {
        try {
          existing = JSON.parse(readFileSync(ctxPath, "utf8")) as Record<string, unknown>;
        } catch {
          // Ignore
        }
      }
      existing.curated_at = new Date().toISOString();
      if (params.summary) {
        let findings: Array<Record<string, unknown>>;
        try {
          findings = JSON.parse(params.summary) as Array<Record<string, unknown>>;
        } catch {
          findings = [{ note: params.summary }];
        }
        for (const f of findings) {
          (existing.entries as Array<Record<string, unknown>>).push({ ...f, added_at: new Date().toISOString() });
        }
      }
      writeFileSync(ctxPath, JSON.stringify(existing, null, 2), "utf8");

      onUpdate?.({
        content: [{ type: "text", text: `Curated ${(existing.entries as Array<unknown>).length} entries` }],
        details: { phase: "complete", action: "curate", entries: (existing.entries as Array<unknown>).length },
      });

      return {
        content: [{ type: "text", text: `Curated ${(existing.entries as Array<unknown>).length} context entries` }],
        details: { action: "curate", entries: (existing.entries as Array<unknown>).length },
      };
    }

    onUpdate?.({
      content: [{ type: "text", text: `Unknown action: ${params.action}` }],
      details: { status: "error", error: "Unknown action" },
    });

    return {
      content: [{ type: "text", text: `Unknown action: '${params.action}'. Valid: init, search, suggest, diff, end, curate.` }],
      details: { error: `Unknown action: '${params.action}'`, valid: ["init", "search", "suggest", "diff", "end", "curate"] },
    };
  },
});

export default factory;
