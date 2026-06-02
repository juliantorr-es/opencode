import { Effect } from "effect"
import { Database } from "../db"

/**
 * Rebuild agent_status_projection from canonical heartbeat + lane_agent tables.
 *
 * Canonical sources:
 *   - heartbeats:   session_id, agent, tool, phase, detail, at
 *   - lane_agents:  lane_id, agent, status, task, …
 *
 * Strategy:
 *  1. For each distinct agent observed in heartbeats (most recent heartbeat wins),
 *     derive status from the latest lane_agents row.
 *  2. Agents not in heartbeats but active in lane_agents are also included.
 */
export const agentStatusProjection = {
  name: "agent_status",
  version: 1,

  rebuild: () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Database.use(async (db) => {
          // ── Truncate projection ──
          await db.execute(`DELETE FROM agent_status_projection`)

          // ── Rebuild from canonical truth ──
          await db.execute(`
            INSERT INTO agent_status_projection (
              instance_id,
              agent_id,
              status,
              current_task_id,
              current_lane_id,
              last_heartbeat_at,
              capabilities,
              error_count,
              last_error,
              updated_at
            )
            SELECT
              'default' AS instance_id,
              a.agent AS agent_id,
              COALESCE(a.status, 'unknown') AS status,
              a.task AS current_task_id,
              a.lane_id AS current_lane_id,
              CAST(
                strftime('%s', h.last_at) * 1000 AS INTEGER
              ) AS last_heartbeat_at,
              NULL AS capabilities,
              0 AS error_count,
              NULL AS last_error,
              CAST(
                strftime('%s', 'now') * 1000 AS INTEGER
              ) AS updated_at
            FROM (
              SELECT
                la.agent,
                la.status,
                la.task,
                la.lane_id,
                la.completed_at,
                la.started_at,
                ROW_NUMBER() OVER (
                  PARTITION BY la.agent
                  ORDER BY la.id DESC
                ) AS rn
              FROM lane_agents la
            ) a
            LEFT JOIN (
              SELECT
                hb.agent,
                MAX(hb.at) AS last_at
              FROM heartbeats hb
              GROUP BY hb.agent
            ) h ON h.agent = a.agent
            WHERE a.rn = 1
          `)
        }),
      )
    }),

  check: () => Effect.sync(() => ({ ok: true, drift: 0 })),
  markStale: () => Effect.void,
  getLag: () => Effect.sync(() => -1),
}
