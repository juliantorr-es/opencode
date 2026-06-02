import { Effect } from "effect"
import { Database } from "../db"

/**
 * Rebuild task_board_projection from canonical lane_agents table.
 *
 * Canonical source:
 *   - lane_agents: lane_id, agent, status, task, started_at,
 *                  completed_at, blockers, findings, delegated_by,
 *                  summary, next_steps, …
 *
 * Each lane_agents row is a task assignment within a lane.
 * The projection flattens this into a board-card view.
 */
export const taskBoardProjection = {
  name: "task_board",
  version: 1,

  rebuild: () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Database.use(async (db) => {
          // ── Truncate projection ──
          await db.execute(`DELETE FROM task_board_projection`)

          // ── Rebuild from canonical truth ──
          await db.execute(`
            INSERT INTO task_board_projection (
              instance_id,
              lane_id,
              task_id,
              task_status,
              task_title,
              task_priority,
              assigned_agent,
              started_at,
              completed_at,
              blocked_reason,
              parent_task_id,
              metadata,
              updated_at
            )
            SELECT
              'default' AS instance_id,
              la.lane_id,
              CAST(la.id AS TEXT) AS task_id,
              la.status AS task_status,
              la.task AS task_title,
              NULL AS task_priority,
              la.agent AS assigned_agent,
              CASE
                WHEN la.started_at IS NOT NULL
                THEN CAST(strftime('%s', la.started_at) * 1000 AS INTEGER)
                ELSE NULL
              END AS started_at,
              CASE
                WHEN la.completed_at IS NOT NULL
                THEN CAST(strftime('%s', la.completed_at) * 1000 AS INTEGER)
                ELSE NULL
              END AS completed_at,
              la.blockers AS blocked_reason,
              NULL AS parent_task_id,
              json_object(
                'delegated_by', la.delegated_by,
                'findings', la.findings,
                'summary', la.summary,
                'next_steps', la.next_steps,
                'files_created', la.files_created,
                'files_modified', la.files_modified,
                'auto_completed', la.auto_completed,
                'repair', la.repair
              ) AS metadata,
              CAST(strftime('%s', 'now') * 1000 AS INTEGER) AS updated_at
            FROM lane_agents la
          `)
        }),
      )
    }),

  check: () => Effect.sync(() => ({ ok: true, drift: 0 })),
  markStale: () => Effect.void,
  getLag: () => Effect.sync(() => -1),
}
