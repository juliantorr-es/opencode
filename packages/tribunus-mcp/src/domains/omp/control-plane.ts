import { registerTool } from "../../server/registry.js"
import type { InvocationContext } from "../../governance/invocation-context.js"
import { getStore, type PgliteDb } from "../../governance/store.js"
import type { Capability } from "../../governance/capabilities.js"
import type { RegisteredTool } from "../../server/registry.js"

function ok(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] } }
function err(msg: string) { return { content: [{ type: "text" as const, text: msg }], isError: true } }

type ToolInputProps = Record<string, { type?: string; enum?: string[]; items?: { type: string }; description?: string }>
type ToolProps = Record<string, unknown>

function register(name: string, desc: string, props: ToolInputProps, req: string[], caps: Capability[], ms: number, fn: (ctx: InvocationContext, a: ToolProps) => Promise<unknown>, aliases?: string[]): void {
  registerTool({
    name,
    description: desc,
    inputSchema: { type: "object", properties: props, required: req },
    requiredCapabilities: caps,
    timeoutMs: ms,
    execute: fn,
    aliases,
  } satisfies Omit<RegisteredTool, "aliases"> & { aliases?: string[] })
}

let _db: PgliteDb | null = null
async function db(): Promise<PgliteDb | null> {
  if (_db) return _db
  try { _db = await getStore(); return _db } catch { return null }
}

export function registerOmpControlPlaneTools(): void {
  // ── Board ────────────────────────────────────────────────────────────────

  register("tribunus_board", "Read campaign->mission->lane->task hierarchy. Authored artifacts from docs/json/omp/ plus runtime sessions/invocations from PGlite.", {
    campaignId: { type: "string" }, missionId: { type: "string" }, includeCompleted: { type: "boolean" },
  }, [], ["github:read"], 30_000, async (_ctx, a) => {
    const d = await db()
    const result: Record<string, unknown> = { sources: {}, sessions: null, danglers: [] }

    // Runtime truth: sessions and invocations from PGlite
    if (d) {
      result.sources = { ...result.sources as Record<string, string>, sessions: "pglite" }
      const filterClause = a.includeCompleted === true ? "" : "WHERE s.status = 'active'"
      const sessionRows = await d.query(
        `SELECT s.*, COUNT(i.invocation_id) as invocation_count
         FROM sessions s LEFT JOIN invocations i ON s.session_id = i.session_id
         ${filterClause} GROUP BY s.session_id ORDER BY s.started_at DESC LIMIT 50`,
      )
      result.sessions = sessionRows.rows
    } else {
      result.sources = { ...result.sources as Record<string, string>, sessions: "unavailable" }
    }

    // Authored artifacts: JSON files in docs/json/omp/
    const { readdir, readFile } = await import("node:fs/promises")
    const { join, resolve } = await import("node:path")
    const base = resolve(process.cwd(), "docs/json/omp")
    for (const dir of ["campaigns", "missions", "lanes", "tasks"]) {
      try {
        const entries = await readdir(join(base, dir))
        const items: unknown[] = []
        for (const f of entries.filter((e: string) => e.endsWith(".v1.json"))) {
          const raw = await readFile(join(base, dir, f), "utf-8")
          items.push(JSON.parse(raw))
        }
        ;(result as Record<string, unknown>)[dir] = items
        ;(result.sources as Record<string, string>)[dir] = "docs/json/omp"
      } catch {
        ;(result as Record<string, unknown>)[dir] = []
        ;(result.sources as Record<string, string>)[dir] = "unavailable"
      }
    }

    // Dangling references: sessions pointing to missions that don't exist in JSON
    if (d && Array.isArray(result.sessions)) {
      const missionIds = new Set(
        ((result.missions as unknown[]) || []).map((m: unknown) => (m as Record<string, unknown>)?.id).filter(Boolean),
      )
      const danglers: string[] = []
      for (const s of result.sessions as Array<Record<string, unknown>>) {
        const missionRef = s.mission_id || s.metadata && typeof s.metadata === "string"
          ? (() => { try { return JSON.parse(s.metadata as string)?.mission_id } catch { return undefined } })()
          : undefined
        if (missionRef && !missionIds.has(String(missionRef))) {
          danglers.push(`session ${s.session_id} references missing mission ${missionRef}`)
        }
      }
      result.danglers = danglers
    }

    return ok(result)
  })

  // ── Recovery ──────────────────────────────────────────────────────────────

  register("tribunus_recover", "Inspect the PGlite store for expired sessions, stale locks, and orphaned invocations. Repair mode requires evidence:admin capability and defaults to dry-run.", {
    mode: { type: "string", enum: ["report","repair"] },
    dry_run: { type: "boolean", description: "Preview repairs without applying (default: true for repair mode)" },
  }, [], ["github:read"], 60_000, async (_ctx, a) => {
    const mode = (a.mode as string) || "report"
    const dryRun = mode === "report" ? true : (a.dry_run !== false)
    const d = await db()
    if (!d) {
      if (mode === "report") {
        return ok({ mode, store_available: false, message: "PGlite store unavailable. Recovery inspection cannot proceed without durable state." })
      }
      return err("PGlite store unavailable. Recovery repair requires an accessible PGlite store.")
    }

    // Heartbeat-based expiry: sessions inactive for > 1 hour (no heartbeat)
    const expiredSessions = await d.query(
      "SELECT session_id, heartbeat_at, owner_pid FROM sessions WHERE status = 'active' AND heartbeat_at < NOW() - INTERVAL '1 hour'",
    )
    // Orphaned invocations: started > 30 min ago, still 'running', no receipt
    const orphanedInvocations = await d.query(
      "SELECT invocation_id, tool, started_at FROM invocations WHERE status = 'running' AND started_at < NOW() - INTERVAL '30 minutes'",
    )
    // Stale locks: expired AND session gone
    const staleLocks = await d.query(
      `SELECT pl.path, pl.session_id, pl.expires_at
       FROM path_locks pl LEFT JOIN sessions s ON pl.session_id = s.session_id
       WHERE pl.expires_at < NOW() AND (s.session_id IS NULL OR s.status != 'active')`,
    )

    const staleReservations = await d.query(`SELECT artifact_id, canonical_path, created_at FROM artifacts_v2 WHERE state IN ('reserved','producing') AND created_at::timestamp < (NOW() - INTERVAL '30 minutes')`)
    const finalizedWithoutBytes = await d.query(`SELECT artifact_id, canonical_path FROM artifacts_v2 WHERE state = 'finalized' AND content_digest IS NOT NULL`)

    const report = {
      mode,
      dry_run: dryRun,
      expired_sessions: expiredSessions.rows.length,
      orphaned_invocations: orphanedInvocations.rows.length,
      stale_locks: staleLocks.rows.length,
      expired_ids: expiredSessions.rows.map(r => r.session_id),
      orphaned_ids: orphanedInvocations.rows.map(r => r.invocation_id),
      stale_lock_paths: staleLocks.rows.map(r => r.path),
      stale_reservations_count: staleReservations.rows.length,
      finalized_without_bytes_count: finalizedWithoutBytes.rows.length,
    }

    if (dryRun) return ok(report)

    // Repair mode: requires evidence:admin
    const capCheck = await import("../../governance/capabilities.js").then(m => m.checkCapability("tribunus_recover"))
    if (!capCheck.allowed || !capCheck.missing.includes("evidence:admin" as never) === false) {
      // Perform repairs transactionally
      let repairsApplied = 0
      const errors: string[] = []
      try {
        if (expiredSessions.rows.length > 0) {
          await d.query("UPDATE sessions SET status = 'expired', ended_at = NOW() WHERE session_id IN (SELECT session_id FROM sessions WHERE status = 'active' AND heartbeat_at < NOW() - INTERVAL '1 hour')")
          repairsApplied += expiredSessions.rows.length
        }
        if (orphanedInvocations.rows.length > 0) {
          await d.query("UPDATE invocations SET status = 'orphaned', ended_at = NOW() WHERE invocation_id IN (SELECT invocation_id FROM invocations WHERE status = 'running' AND started_at < NOW() - INTERVAL '30 minutes')")
          repairsApplied += orphanedInvocations.rows.length
        }
        if (staleLocks.rows.length > 0) {
          await d.query("DELETE FROM path_locks WHERE path IN (SELECT pl.path FROM path_locks pl LEFT JOIN sessions s ON pl.session_id = s.session_id WHERE pl.expires_at < NOW() AND (s.session_id IS NULL OR s.status != 'active'))")
          repairsApplied += staleLocks.rows.length
        }
        if (staleReservations.rows.length > 0) {
          const ids = staleReservations.rows.map((r) => r.artifact_id)
          await d.query("UPDATE artifacts_v2 SET state = 'partial' WHERE artifact_id = ANY($1::text[])", [ids])
          repairsApplied += staleReservations.rows.length
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
      return ok({ ...report, repaired: true, repairs_applied: repairsApplied, errors: errors.length > 0 ? errors : undefined })
    }

    return err("Repair mode requires evidence:admin capability. Set TRIBUNUS_CAPABILITIES=evidence:admin to enable.")
  })

  // ── History ───────────────────────────────────────────────────────────────

  register("tribunus_history", "Query invocation history with cursor pagination (timestamp + invocation_id).", {
    mode: { type: "string", enum: ["recent","session","failures","path"] },
    session_id: { type: "string" }, path: { type: "string" },
    limit: { type: "number" }, cursor_ts: { type: "string" }, cursor_id: { type: "string" },
  }, [], ["github:read"], 30_000, async (_ctx, a) => {
    const d = await db()
    if (!d) return ok({ mode: a.mode || "recent", store_available: false, invocations: [] })

    const mode = (a.mode as string) || "recent"
    const limit = Math.min((a.limit as number) || 20, 100)
    const cursorTs = (a.cursor_ts as string) || ""
    const cursorId = (a.cursor_id as string) || ""

    let whereClause = ""
    let cursorClause = ""
    const params: unknown[] = []

    if (cursorTs && cursorId) {
      cursorClause = "AND (i.started_at, i.invocation_id) < ($2, $3)"
      params.push(cursorTs, cursorId)
    }

    switch (mode) {
      case "session": {
        if (!a.session_id) return err("session_id required for mode=session")
        whereClause = "WHERE i.session_id = $1"
        params.unshift(a.session_id)
        break
      }
      case "failures": {
        whereClause = "WHERE i.status = 'failed'"
        break
      }
      case "path": {
        if (!a.path) return err("path required for mode=path")
        whereClause = "JOIN artifacts a ON i.invocation_id = a.invocation_id WHERE a.path = $1"
        params.unshift(a.path)
        break
      }
      default: {
        // recent — no extra filter
        whereClause = "WHERE 1=1"
        break
      }
    }

    const rows = await d.query(
      `SELECT i.* FROM invocations i ${whereClause} ${cursorClause}
       ORDER BY i.started_at DESC, i.invocation_id DESC LIMIT $${params.length + 1}`,
      [...params, limit + 1],
    )

    const hasMore = rows.rows.length > limit
    const results = hasMore ? rows.rows.slice(0, limit) : rows.rows
    const nextCursor = hasMore && results.length > 0
      ? { started_at: results[results.length - 1].started_at, invocation_id: results[results.length - 1].invocation_id }
      : null

    return ok({ mode, count: results.length, has_more: hasMore, next_cursor: nextCursor, invocations: results })
  })

  // ── Memory Sync ───────────────────────────────────────────────────────────

  register("tribunus_memory_sync", "Bidirectional sync between Mnemopi (bun:sqlite) and the Tribunus PGlite store.", {
    direction: { type: "string", enum: ["from_mnemopi","to_mnemopi","both"] },
  }, [], ["github:read"], 60_000, async (_ctx, a) => {
    const d = await db()
    if (!d) return err("PGlite store unavailable.")
    const direction = (a.direction as string) || "both"
    const { syncFromMnemopi, syncToMnemopi } = await import("../../governance/sync.js")
    const results: Array<import("../../governance/sync.js").SyncResult> = []
    if (direction === "from_mnemopi" || direction === "both") results.push(await syncFromMnemopi(d))
    if (direction === "to_mnemopi" || direction === "both") results.push(await syncToMnemopi(d))
    const total = results.reduce((s, r) => s + r.memories_synced, 0)
    return ok({ direction, results, total_synced: total })
  })

  register("tribunus_memory_recall", "Search synced memories in the Tribunus PGlite store.", {
    query: { type: "string" }, limit: { type: "number" },
  }, ["query"], ["github:read"], 15_000, async (_ctx, a) => {
    const d = await db()
    if (!d) return err("PGlite store unavailable.")
    const { queryMemories } = await import("../../governance/sync.js")
    const memories = await queryMemories(d, a.query as string, (a.limit as number) || 20)
    return ok({ query: a.query, count: memories.length, memories })
  })
}
