import { registerTool } from "../../server/registry.js"
import type { InvocationContext } from "../../governance/invocation-context.js"
import { getStore, type PgliteDb } from "../../governance/store.js"

function ok(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] } }
function err(msg: string) { return { content: [{ type: "text" as const, text: msg }], isError: true } }

function t(name: string, desc: string, props: Record<string, unknown>, req: string[], caps: string[], ms: number, fn: (ctx: InvocationContext, a: Record<string, unknown>) => Promise<unknown>) {
  registerTool({
    name,
    description: desc,
    inputSchema: { type: "object" as const, properties: props as Record<string, { type?: string; enum?: string[]; items?: { type: string }; description?: string }>, required: req },
    requiredCapabilities: caps as import("../../governance/capabilities.js").Capability[],
    timeoutMs: ms,
    execute: fn,
    aliases: [],
  })
}

let _db: PgliteDb | null = null
async function db(): Promise<PgliteDb | null> {
  if (_db) return _db
  try { _db = await getStore(); return _db } catch { return null }
}

export function registerOmpControlPlaneTools(): void {
  t("tribunus_board", "Read campaign->mission->lane->task hierarchy from the managed PGlite store and docs/json/omp/.", {
    campaignId: { type: "string" }, missionId: { type: "string" }, includeCompleted: { type: "boolean" },
  }, [], ["github:read"], 30_000, async (_ctx, a) => {
    // Query sessions and invocations from the managed store
    const d = await db()
    const includeCompleted = a.includeCompleted === true
    let sessions: Array<Record<string, unknown>> = []
    if (d) {
      const filter = includeCompleted ? "" : "WHERE status = 'active'"
      const r = await d.query(`SELECT * FROM sessions ${filter} ORDER BY started_at DESC LIMIT 50`)
      sessions = r.rows
    }
    // Also read docs/json/omp/ for campaign/mission/lane/task JSON files
    const { readdir, readFile } = await import("node:fs/promises")
    const { join, resolve } = await import("node:path")
    const base = resolve(process.cwd(), "docs/json/omp")
    const board: Record<string, unknown> = {}
    for (const dir of ["campaigns", "missions", "lanes", "tasks"]) {
      try {
        const entries = await readdir(join(base, dir))
        const items: unknown[] = []
        for (const f of entries.filter((e: string) => e.endsWith(".v1.json"))) {
          const raw = await readFile(join(base, dir, f), "utf-8")
          items.push(JSON.parse(raw))
        }
        board[dir] = items
      } catch { board[dir] = [] }
    }
    return ok({ sessions: sessions.length > 0 ? sessions : undefined, ...board })
  })

  t("tribunus_recover", "Inspect the managed PGlite store for expired sessions, stale locks, and orphaned rows.", {
    mode: { type: "string", enum: ["report","repair"] },
  }, [], ["github:read"], 60_000, async (_ctx, a) => {
    const mode = (a.mode as string) || "report"
    const d = await db()
    if (!d) return ok({ mode, pglite_available: false, message: "PGlite store unavailable. Install @electric-sql/pglite for full recovery." })

    // Find expired sessions
    const expiredSessions = await d.query(
      "SELECT session_id, started_at FROM sessions WHERE status = 'active' AND started_at < NOW() - INTERVAL '24 hours'",
    )
    // Find invocations without receipts
    const missingReceipts = await d.query(
      "SELECT invocation_id, tool, started_at FROM invocations WHERE receipt IS NULL AND started_at < NOW() - INTERVAL '1 hour'",
    )
    // Find stale path locks
    const staleLocks = await d.query(
      "SELECT path, session_id, acquired_at FROM path_locks WHERE expires_at IS NOT NULL AND expires_at < NOW()",
    )

    const report = {
      mode,
      expired_sessions: expiredSessions.rows.length,
      missing_receipts: missingReceipts.rows.length,
      stale_locks: staleLocks.rows.length,
      details: {
        expired_session_ids: expiredSessions.rows.map(r => r.session_id),
        missing_receipt_ids: missingReceipts.rows.map(r => r.invocation_id),
        stale_lock_paths: staleLocks.rows.map(r => r.path),
      },
    }

    if (mode === "repair") {
      // Clean up expired sessions
      if (expiredSessions.rows.length > 0) {
        await d.query("UPDATE sessions SET status = 'expired', ended_at = NOW() WHERE session_id IN (SELECT session_id FROM sessions WHERE status = 'active' AND started_at < NOW() - INTERVAL '24 hours')")
      }
      // Clean up stale locks
      if (staleLocks.rows.length > 0) {
        await d.query("DELETE FROM path_locks WHERE expires_at IS NOT NULL AND expires_at < NOW()")
      }
      return ok({ ...report, repaired: true, cleaned_sessions: expiredSessions.rows.length, cleaned_locks: staleLocks.rows.length })
    }

    return ok(report)
  })

  t("tribunus_history", "Query session and invocation history from the managed PGlite store.", {
    mode: { type: "string", enum: ["recent","session","path","failures"] }, session_id: { type: "string" }, path: { type: "string" }, limit: { type: "number" },
  }, [], ["github:read"], 30_000, async (_ctx, a) => {
    const d = await db()
    if (!d) return ok({ mode: a.mode || "recent", pglite_available: false, message: "PGlite store unavailable. History queries require @electric-sql/pglite." })

    const mode = (a.mode as string) || "recent"
    const limit = (a.limit as number) || 20
    let rows: Array<Record<string, unknown>> = []

    switch (mode) {
      case "recent":
        rows = (await d.query("SELECT * FROM invocations ORDER BY started_at DESC LIMIT $1", [limit])).rows
        break
      case "session":
        if (!a.session_id) return err("session_id required for mode=session")
        rows = (await d.query("SELECT * FROM invocations WHERE session_id = $1 ORDER BY started_at DESC LIMIT $2", [a.session_id, limit])).rows
        break
      case "failures":
        rows = (await d.query("SELECT * FROM invocations WHERE status = 'failed' ORDER BY started_at DESC LIMIT $1", [limit])).rows
        break
      case "path":
        if (!a.path) return err("path required for mode=path")
        rows = (await d.query(
          "SELECT i.* FROM invocations i JOIN artifacts a ON i.invocation_id = a.invocation_id WHERE a.path = $1 ORDER BY i.started_at DESC LIMIT $2",
          [a.path, limit],
        )).rows
        break
      default:
        return err(`Unknown mode: ${mode}`)
    }

    return ok({ mode, count: rows.length, invocations: rows })
  })

  // ── Mnemopi Sync & Memory ──

  t("tribunus_memory_sync", "Bidirectional sync between Mnemopi (bun:sqlite) and the Tribunus PGlite store. Pulls new memories from Mnemopi into Tribunus, pushes Tribunus-stored memories back to Mnemopi.", {
    direction: { type: "string", enum: ["from_mnemopi", "to_mnemopi", "both"] },
  }, [], ["github:read"], 60_000, async (_ctx, a) => {
    const d = await db()
    if (!d) return err("PGlite store unavailable.")
    const direction = (a.direction as string) || "both"
    const { syncFromMnemopi, syncToMnemopi } = await import("../../governance/sync.js")
    const results: Array<import("../../governance/sync.js").SyncResult> = []
    if (direction === "from_mnemopi" || direction === "both") {
      results.push(await syncFromMnemopi(d))
    }
    if (direction === "to_mnemopi" || direction === "both") {
      results.push(await syncToMnemopi(d))
    }
    const total = results.reduce((s, r) => s + r.memories_synced, 0)
    return ok({ direction, results, total_synced: total })
  })

  t("tribunus_memory_recall", "Search synced memories in the Tribunus PGlite store. Queries the local mnemopi_memory table by content substring.", {
    query: { type: "string" }, limit: { type: "number" },
  }, ["query"], ["github:read"], 15_000, async (_ctx, a) => {
    const d = await db()
    if (!d) return err("PGlite store unavailable.")
    const { queryMemories } = await import("../../governance/sync.js")
    const memories = await queryMemories(d, a.query as string, (a.limit as number) || 20)
    return ok({ query: a.query, count: memories.length, memories })
  })
}
