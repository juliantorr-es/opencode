import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { existsSync, readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs"

function resolvePath(worktree: string, p: string): string { return resolve(worktree, p) }

export default tool({
  description: "Session lifecycle manager — init, search, suggest, diff, end. One tool for everything session-related.",
  args: {
    action: tool.schema.string().describe("init | search | suggest | diff | end | curate"),
    query: tool.schema.string().optional().describe("Search query (for search action)"),
    file: tool.schema.string().optional().describe("File filter (for search/diff actions)"),
    agent: tool.schema.string().optional().describe("Agent filter (for search action)"),
    roadmap_item: tool.schema.string().optional().describe("Roadmap item filter (for search action)"),
    summary: tool.schema.string().optional().describe("Session summary (for end action)"),
    limit: tool.schema.number().optional().describe("Max results (default 5 for suggest, 10 for search)"),
  },
  async execute(args, context) {
    const base = resolvePath(context.worktree, "docs/json/opencode")
    const sessionDir = resolve(base, "sessions", context.sessionID)

    // ── INIT ──
    if (args.action === "init") {
      // Check for unfinished previous session
      const archiveDir = resolve(base, "archive")
      let recovery: any = null
      if (existsSync(archiveDir)) {
        try {
          const archives = readdirSync(archiveDir).filter(f => f.endsWith(".v1.json") && !f.startsWith("."))
          if (archives.length > 0) {
            const lastArchive = archives.sort().pop()!
            const archived = JSON.parse(readFileSync(resolve(archiveDir, lastArchive), "utf8"))
            // Check if this session ended properly (has summary)
            if (!archived.summary || archived.summary === "null") {
              recovery = {
                previous_session: archived.session_id,
                agents_involved: archived.agents_involved,
                files_touched: archived.files_touched,
                status: "unfinished — no summary found. Previous session may have crashed.",
                resume_hint: "Re-delegate the lanes that were in progress. Files touched may have uncommitted changes."
              }
            }
          }
        } catch {}
      }
      // Check Rust tools
      const rustTools: Record<string, boolean> = {}
      for (const t of ["rg", "fd", "bat", "eza", "delta"]) {
        const r = spawnSync("which", [t], { encoding: "utf8", timeout: 3000 })
        rustTools[t] = r.status === 0
      }
      const missing = Object.entries(rustTools).filter(([, ok]) => !ok).map(([t]) => t)

      // Read roadmap
      const roadmapPath = resolve(base, "roadmaps/active.v1.json")
      let nextItems: any[] = []
      if (existsSync(roadmapPath)) {
        try {
          const active = JSON.parse(readFileSync(roadmapPath, "utf8"))
          const completed = new Set((active.items || []).filter((i: any) => i.status === "completed" || i.completion_pct >= 100).map((i: any) => i.id))
          nextItems = (active.items || [])
            .filter((i: any) => i.status !== "completed" && i.status !== "deprecated" && i.completion_pct < 100)
            .filter((i: any) => !(i.depends_on || []).some((d: string) => !completed.has(d)))
            .sort((a: any, b: any) => (a.priority || 99) - (b.priority || 99))
            .slice(0, 5)
        } catch {}
      }

      return JSON.stringify({
        action: "init",
        roadmap: nextItems.map(i => ({ id: i.id, title: i.title, phase: i.phase, next_step: i.next_step })),
        environment: { rust_tools: rustTools, missing, hint: missing.length ? `brew install ${missing.join(" ")}` : "All tools available" },
        recommendation: nextItems[0] ? `Delegate: ${nextItems[0].id} — ${nextItems[0].title}` : "Run session_suggest for guidance.",
      }, null, 2)
    }

    // ── SEARCH ──
    if (args.action === "search") {
      const archivePath = resolve(base, "archive/sessions.v1.jsonl")
      if (!existsSync(archivePath)) return JSON.stringify({ action: "search", results: [], hint: "No archive yet." }, null, 2)

      let entries: any[] = []
      try {
        entries = readFileSync(archivePath, "utf8").split("\n").filter(Boolean)
          .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      } catch { return JSON.stringify({ action: "search", results: [], error: "Archive corrupted" }, null, 2) }

      const limit = args.limit ?? 10
      let filtered = entries
      if (args.file) filtered = filtered.filter(e => (e.files_touched || []).some((f: string) => f.includes(args.file!)))
      if (args.agent) filtered = filtered.filter(e => (e.agents_involved || []).some((a: string) => a.includes(args.agent!)))
      if (args.roadmap_item) filtered = filtered.filter(e => (e.roadmap_items_touched || []).some((r: any) => r.id === args.roadmap_item))
      if (args.query) {
        const q = args.query.toLowerCase()
        filtered = filtered.filter(e => JSON.stringify(e).toLowerCase().includes(q))
      }

      filtered.sort((a, b) => (b.archived_at || "").localeCompare(a.archived_at || ""))
      return JSON.stringify({
        action: "search",
        results: filtered.slice(0, limit).map(e => ({
          session: e.session_id?.slice(0, 16), archived: e.archived_at?.slice(0, 19),
          summary: e.summary?.slice(0, 150), files: (e.files_touched || []).length,
          friction: e.friction_entries || 0, failures: e.tool_failures || 0,
        })),
        total: filtered.length,
      }, null, 2)
    }

    // ── SUGGEST ──
    if (args.action === "suggest") {
      const limit = args.limit ?? 5
      const suggestions: any[] = []

      // Read lessons
      const lessons: any[] = []
      const lp = resolve(base, "knowledge/lessons.v1.jsonl")
      if (existsSync(lp)) {
        try { lessons.push(...readFileSync(lp, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)) } catch {}
      }

      // Read friction across sessions
      const frictionItems: any[] = []
      const sessionsDir = resolve(base, "sessions")
      if (existsSync(sessionsDir)) {
        for (const dir of readdirSync(sessionsDir, { withFileTypes: true }).filter(d => d.isDirectory())) {
          const fp = resolve(sessionsDir, dir.name, "feedback/friction.v1.jsonl")
          if (!existsSync(fp)) continue
          try { for (const line of readFileSync(fp, "utf8").split("\n").filter(Boolean)) { try { frictionItems.push({ ...JSON.parse(line), session: dir.name.slice(0, 16) }) } catch {} } } catch {}
        }
      }

      // Read findings
      const findings: any[] = []
      const fip = resolve(base, "knowledge/findings.v1.jsonl")
      if (existsSync(fip)) {
        try { findings.push(...readFileSync(fip, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)) } catch {}
      }

      // Roadmap
      const roadmap: any[] = []
      const rp = resolve(base, "roadmaps/active.v1.json")
      if (existsSync(rp)) { try { roadmap.push(...(JSON.parse(readFileSync(rp, "utf8")).items || [])) } catch {} }

      // Roadmap items ready
      const completed = new Set(roadmap.filter(i => i.status === "completed" || i.completion_pct >= 100).map(i => i.id))
      const ready = roadmap.filter(i => i.status !== "completed" && i.status !== "deprecated")
        .filter(i => !(i.depends_on || []).some((d: string) => !completed.has(d)))
        .sort((a, b) => (a.priority || 99) - (b.priority || 99))

      for (const item of ready.slice(0, limit)) {
        const relLessons = lessons.filter(l => item.title?.toLowerCase().includes(l.pattern?.toLowerCase() || "") || l.lesson?.toLowerCase().includes(item.title?.toLowerCase() || ""))
        const relFriction = frictionItems.filter(f => f.note?.toLowerCase().includes(item.title?.toLowerCase()?.slice(0, 20) || ""))
        suggestions.push({
          type: "roadmap", priority: item.priority || 99, item_id: item.id, title: item.title,
          next_step: item.next_step, context: item.context_summary?.slice(0, 200),
          lessons: relLessons.slice(0, 2).map(l => l.lesson),
          friction_count: relFriction.length,
          recommendation: relFriction.length > 0 ? `WARNING: ${relFriction.length} friction reports. Review first.` : "No prior friction.",
        })
      }

      // Recurring friction
      const byPattern: Record<string, { count: number; sessions: Set<string> }> = {}
      for (const f of frictionItems) {
        const key = f.note?.slice(0, 80) || "?"
        if (!byPattern[key]) byPattern[key] = { count: 0, sessions: new Set() }
        byPattern[key].count++
        byPattern[key].sessions.add(f.session || "")
      }
      for (const [pattern, data] of Object.entries(byPattern).filter(([, v]) => v.count >= 2).sort(([, a], [, b]) => b.count - a.count).slice(0, 3)) {
        suggestions.push({ type: "friction_fix", priority: 0, pattern: pattern.slice(0, 100), occurrences: data.count, across_sessions: data.sessions.size, recommendation: `Recurring (${data.count}x). Fix root cause.` })
      }

      // Unfixed bugs
      for (const b of findings.filter(f => f.finding_type === "bug" && f.status !== "fixed").slice(0, 3)) {
        suggestions.push({ type: "unfixed_bug", priority: 1, summary: b.summary, file: b.file, recommendation: `Unfixed: ${b.summary?.slice(0, 100)}` })
      }

      suggestions.sort((a, b) => (a.priority || 99) - (b.priority || 99))
      return JSON.stringify({
        action: "suggest",
        suggestions: suggestions.slice(0, limit),
        summary: { roadmap_ready: ready.length, recurring_friction: Object.values(byPattern).filter(v => v.count >= 2).length, unfixed_bugs: findings.filter(f => f.finding_type === "bug" && f.status !== "fixed").length, lessons: lessons.length },
      }, null, 2)
    }

    // ── DIFF ──
    if (args.action === "diff") {
      const editLogPath = resolve(sessionDir, "edits/edit_log.v1.jsonl")
      const filesCreated = new Set<string>(), filesModified = new Set<string>()
      let totalEdits = 0

      if (existsSync(editLogPath)) {
        try {
          for (const line of readFileSync(editLogPath, "utf8").split("\n").filter(Boolean)) {
            try {
              const e = JSON.parse(line); totalEdits++
              const fp = e.file || ""
              if ((e.change_summary || e.action || "").includes("create")) filesCreated.add(fp)
              else filesModified.add(fp)
            } catch {}
          }
        } catch {}
      }

      // Git fallback
      if (totalEdits === 0) {
        try {
          const r = spawnSync("git", ["diff", "--name-status", "HEAD"], { encoding: "utf8", timeout: 10000 })
          if (r.status === 0 && r.stdout?.trim()) {
            for (const line of r.stdout.trim().split("\n")) {
              const parts = line.split("\t"); if (parts.length < 2) continue
              if (parts[0]!.startsWith("A")) filesCreated.add(parts[1]!)
              else filesModified.add(parts[1]!)
              totalEdits++
            }
          }
        } catch {}
      }

      let netLines = "+0/-0"
      try {
        const r = spawnSync("git", ["diff", "--stat", "HEAD"], { encoding: "utf8", timeout: 10000 })
        if (r.status === 0 && r.stdout?.trim()) netLines = r.stdout.trim().split("\n").pop()!.trim()
      } catch {}

      return JSON.stringify({
        action: "diff",
        files_created: filesCreated.size, files_modified: filesModified.size,
        total_edits: totalEdits, net_lines: netLines,
        created: [...filesCreated].sort(), modified: [...filesModified].sort(),
      }, null, 2)
    }

    // ── END ──
    if (args.action === "end") {
      // Auto-consolidate any pending fragments before archiving
      let consolidation: any = null
      const fragDir = resolve(sessionDir, "fragments")
      if (existsSync(fragDir)) {
        try {
          const fragments = readdirSync(fragDir).filter(f => f.endsWith(".json"))
          if (fragments.length > 0) {
            // Group by target file
            const byFile: Record<string, string[]> = {}
            for (const f of fragments) {
              try {
                const frag = JSON.parse(readFileSync(resolve(fragDir, f), "utf8"))
                const target = frag.target_file || "unknown"
                if (!byFile[target]) byFile[target] = []
                byFile[target].push(frag.lane_id || f)
              } catch {}
            }
            consolidation = { fragments_found: fragments.length, files: Object.keys(byFile).length, note: "Fragments consolidated automatically." }
            // Basic consolidation: append all fragments to their target files
            for (const [target, lanes] of Object.entries(byFile)) {
              const targetPath = resolve(context.worktree, target)
              let merged = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : ""
              for (const lane of lanes) {
                const fragFile = resolve(fragDir, `${lane}.v1.json`)
                if (existsSync(fragFile)) {
                  try {
                    const frag = JSON.parse(readFileSync(fragFile, "utf8"))
                    if (frag.content) merged += `\n// --- ${frag.lane_id} ---\n${frag.content}`
                  } catch {}
                }
              }
              if (merged) writeFileSync(targetPath, merged, "utf8")
            }
          }
        } catch {}
      }
      const archivePath = resolve(base, "archive/sessions.v1.jsonl")
      try { mkdirSync(resolve(base, "archive"), { recursive: true }) } catch (_) {}

      const highlights: any = {
        schema: "v1", session_id: context.sessionID, agent: context.agent,
        archived_at: new Date().toISOString(), summary: args.summary || null,
      }

      // Artifact
      const artPath = resolve(sessionDir, "artifacts", `${context.sessionID}.v1.json`)
      if (existsSync(artPath)) {
        try { const a = JSON.parse(readFileSync(artPath, "utf8")); highlights.tools_used = a.tools_used; highlights.files_touched = a.files_touched; highlights.total_events = a.total_events } catch {}
      }

      // Friction
      const frictionPath = resolve(sessionDir, "feedback/friction.v1.jsonl")
      if (existsSync(frictionPath)) {
        try {
          const fe = readFileSync(frictionPath, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
          highlights.friction_entries = fe.length
          highlights.friction_summary = fe.slice(0, 3).map((e: any) => e.note?.slice(0, 120))
        } catch {}
      }

      // Heartbeat
      const hbPath = resolve(sessionDir, "analytics/heartbeat.v1.jsonl")
      if (existsSync(hbPath)) {
        try {
          const lines = readFileSync(hbPath, "utf8").split("\n").filter(Boolean)
          const agents = new Set<string>(); let failures = 0
          for (const line of lines) { try { const hb = JSON.parse(line); agents.add(hb.agent); if (hb.phase === "failed") failures++ } catch {} }
          highlights.agents_involved = [...agents]; highlights.tool_calls = lines.length; highlights.tool_failures = failures
        } catch {}
      }

      // Handoffs
      const coordPath = resolve(base, "coordination/messages.v1.jsonl")
      if (existsSync(coordPath)) {
        try {
          const handoffs = readFileSync(coordPath, "utf8").split("\n").filter(Boolean)
            .map(l => { try { return JSON.parse(l) } catch { return null } }).filter((m: any) => m?.kind === "handoff")
          highlights.handoffs = handoffs.length
        } catch {}
      }

      appendFileSync(archivePath, JSON.stringify(highlights) + "\n", "utf8")
      writeFileSync(resolve(base, "archive", `${context.sessionID}.v1.json`), JSON.stringify(highlights, null, 2), "utf8")

      return JSON.stringify({ action: "end", status: "archived", session: context.sessionID, highlights, hint: "Session archived. Use smart_session(action='search') to find past sessions." }, null, 2)
    }

    if (args.action === "curate") {
      const ctxDir = r(context.worktree, `docs/json/opencode/sessions/${context.sessionID}/context`);
      const ctxPath = r(ctxDir, "current.v1.json");
      try { mkdirSync(ctxDir, { recursive: true }); } catch (_) {}
      let existing = { schema_version: "v1", entries: [], curated_at: null };
      if (existsSync(ctxPath)) { try { existing = JSON.parse(readFileSync(ctxPath, "utf8")); } catch {} }
      existing.curated_at = new Date().toISOString();
      if (args.summary) {
        let findings = [];
        try { findings = JSON.parse(args.summary); } catch { findings = [{ note: args.summary }]; }
        for (const f of findings) { existing.entries.push(Object.assign({}, f, { added_at: new Date().toISOString() })); }
      }
      writeFileSync(ctxPath, JSON.stringify(existing, null, 2), "utf8");
      return JSON.stringify({ action: "curate", entries: existing.entries.length }, null, 2);
    }
    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: init, search, suggest, diff, end.` }, null, 2)
  },
})
