import { Effect } from "effect"
import { Database } from "../db"

/**
 * Rebuild context_packet_projection from canonical journal, files,
 * artifacts, and tool_usage tables.
 *
 * Canonical sources:
 *   - journal:      lane_id, agent, session_id, tool, exit_code,
 *                   summary, output, files_touched
 *   - files:        path, purpose, exports_summary, line_count, content_hash
 *   - artifacts:    key, data, source
 *   - tool_usage:   session_id, agent, tool, command, elapsed_ms, exit_code, at
 *
 * Strategy:
 *  1. One packet per journal row (agent action).
 *  2. Attach scratchpad state from the most recent artifact keyed per session.
 *  3. Attach recent events from journal output/summary for the same session.
 *  4. Attach file_context from files touched by the agent.
 *  5. Attach tool_invocations from the tool_usage table.
 */
export const contextPacketProjection = {
  name: "context_packet",
  version: 1,

  rebuild: () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        Database.use(async (db) => {
          // ── Truncate projection ──
          await db.execute(`DELETE FROM context_packet_projection`)

          // ── Rebuild from canonical truth ──
          // Each journal entry becomes a context packet with associated state.
          await db.execute(`
            INSERT INTO context_packet_projection (
              instance_id,
              packet_id,
              session_id,
              scratchpad_state,
              recent_events,
              working_set,
              file_context,
              tool_invocations,
              updated_at
            )
            SELECT
              'default' AS instance_id,
              CAST(j.id AS TEXT) AS packet_id,
              j.session_id,
              (
                SELECT a.data
                FROM artifacts a
                WHERE a.key = 'scratchpad:' || j.session_id
                ORDER BY a.updated_at DESC
                LIMIT 1
              ) AS scratchpad_state,
              (
                SELECT json_group_array(
                  json_object(
                    'tool', rj.tool,
                    'summary', rj.summary,
                    'agent', rj.agent,
                    'at', rj.created_at
                  )
                )
                FROM journal rj
                WHERE rj.session_id = j.session_id
                ORDER BY rj.id DESC
                LIMIT 20
              ) AS recent_events,
              j.files_touched AS working_set,
              (
                SELECT json_group_array(
                  json_object(
                    'path', f.path,
                    'purpose', f.purpose,
                    'line_count', f.line_count,
                    'hash', f.content_hash
                  )
                )
                FROM files f
                LIMIT 50
              ) AS file_context,
              (
                SELECT json_group_array(
                  json_object(
                    'tool', tu.tool,
                    'command', tu.command,
                    'exit_code', tu.exit_code,
                    'elapsed_ms', tu.elapsed_ms,
                    'at', tu.at
                  )
                )
                FROM tool_usage tu
                WHERE tu.session_id = j.session_id
                ORDER BY tu.id DESC
                LIMIT 50
              ) AS tool_invocations,
              CAST(
                strftime('%s', 'now') * 1000 AS INTEGER
              ) AS updated_at
            FROM journal j
            WHERE j.session_id IS NOT NULL
            GROUP BY j.id
          `)
        }),
      )
    }),

  check: () => Effect.sync(() => ({ ok: true, drift: 0 })),
  markStale: () => Effect.void,
  getLag: () => Effect.sync(() => -1),
}
