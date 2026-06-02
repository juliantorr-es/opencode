# Projection Schemas — Flattened Read Models

> Status: **Design** · Schema versions: v1

Read-optimized materialized views that denormalize canonical tables for
hot-path queries. Each projection is rebuilt from a defined source of
truth, updated on specific triggers, and verified with a consistency
check.

---

## 1. `task_board_projection`

Flattens lane-scoped tasks from the coordination claim table, todo
table, and campaign lane state into a single queryable board.

### Schema

```sql
CREATE TABLE IF NOT EXISTS task_board_projection (
  instance_id     TEXT NOT NULL,
  lane_id         TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  task_status     TEXT NOT NULL,          -- pending|in_progress|completed|cancelled|blocked|failed
  task_title      TEXT,                   -- denormalised from TodoTable.content or CoordinationClaimTable.description
  task_priority   TEXT,                   -- high|medium|low
  assigned_agent  TEXT,                   -- subagent_type from CoordinationClaimTable
  started_at      BIGINT,                -- epoch ms
  completed_at    BIGINT,                -- epoch ms
  blocked_reason  TEXT,                   -- from RuntimeEvent.payload_json when blocked
  parent_task_id  TEXT,                  -- from CoordinationFanOutTable.task_ids
  metadata        JSONB,                 -- arbitrary lane-scoped context (scope, wave, etc.)
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (instance_id, lane_id, task_id)
);
```

### Source of Truth

| Field | Canonical source | Notes |
|---|---|---|
| `instance_id` | `SessionTable.id` | The owning session/project instance |
| `lane_id` | `CoordinatedClaimTable.task_id` prefix / lane namespace | Derived from lane scope in secretary |
| `task_id` | `CoordinatedClaimTable.task_id` | Canonical task identity |
| `task_status` | `CoordinatedClaimTable.status` + `TodoTable.status` | Union of claim lifecycle and todo lifecycle |
| `task_title` | `TodoTable.content` / `CoordinatedClaimTable.description` | Prefer todo content; fall back to claim description |
| `task_priority` | `TodoTable.priority` | Directly from todo table |
| `assigned_agent` | `CoordinatedClaimTable.subagent_type` | The agent type that claimed the task |
| `started_at` | `CoordinatedClaimTable.created_at` | Claim creation time |
| `completed_at` | `CoordinatedClaimTable.released_at` | Release or completion timestamp |
| `blocked_reason` | `RuntimeEventTable.payload_json` | Extracted from Blocked events with matching `lane_id` |
| `parent_task_id` | `CoordinatedFanOutTable.task_ids` | Fan-out parent if this task was part of a wave |
| `metadata` | `CoordinatedClaimTable` + `CoordinationReservationTable` | Wave number, reservation paths, scope |
| `updated_at` | `MAX(coord.created_at, todo.time_updated, event.time_created)` | Most recent touch across all sources |

### Update Trigger

- `Todo.Updated` bus event (when `Todo.update()` publishes)
- `CoordinationClaimTable` insert/update (claim status changes)
- `RuntimeEvent` of type `"Blocked"` or `"Failed"` for a tracked lane

### Rebuild Command

```typescript
function rebuildTaskBoardProjection(
  db: TxOrDb,
  instanceId: string,
  laneIds: string[],
): Effect.Effect<void, DatabaseError>
```

Replays: reads all `CoordinationClaimTable` rows for the given
`instance_id`/`lane_id` scope, joins against `TodoTable` by session,
and enriches with the latest `RuntimeEventTable` blocked/failed
events.

### Staleness Policy

**Event-driven.** No TTL. The projection is refreshed immediately on
any of the three trigger sources. A periodic reconciliation sweep
(every 60 s) catches missed events by comparing `updated_at` against
the max source timestamp.

### Schema Version

**1**

### Consistency Check

```sql
SELECT lane_id, task_id
FROM task_board_projection
EXCEPT
SELECT
  c.task_id AS lane_id,
  c.task_id AS task_id
FROM coordination_claim c
WHERE c.status != 'released'
UNION ALL
SELECT
  t.session_id AS lane_id,
  t.session_id || '-' || t.position AS task_id
FROM todo t
WHERE t.status != 'completed';
```

Any row returned indicates a projection drift (a row exists in the
source that is missing from the projection, or vice versa). A
production check runs this diff periodically and triggers a full
rebuild on mismatch.

---

## 2. `agent_status_projection`

Materialises the liveness and assignment state of every agent in the
system from the runtime event stream and coordination tables.

### Schema

```sql
CREATE TABLE IF NOT EXISTS agent_status_projection (
  instance_id        TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  status             TEXT NOT NULL,          -- idle|busy|error|dead
  current_task_id    TEXT,                   -- CoordinationClaimTable.task_id
  current_lane_id    TEXT,                   -- derived from RuntimeEventTable.lane_id
  last_heartbeat_at  BIGINT,                -- epoch ms
  capabilities       JSONB,                 -- denormalised tool/role list
  error_count        INTEGER DEFAULT 0,     -- rolling count since last successful completion
  last_error         TEXT,                   -- most recent error_message
  updated_at         BIGINT NOT NULL,
  PRIMARY KEY (instance_id, agent_id)
);
```

### Source of Truth

| Field | Canonical source | Notes |
|---|---|---|
| `instance_id` | `SessionTable.id` | Owning session |
| `agent_id` | `RuntimeEventTable.actor` | Agent identity from event stream |
| `status` | Derived from `CoordinatedClaimTable.status` + heartbeat age | `idle` if no active claim and heartbeat fresh; `busy` if active claim; `error` if last event was failure; `dead` if heartbeat stale |
| `current_task_id` | `CoordinatedClaimTable.task_id` WHERE `status = 'claimed'` | Active task for this agent |
| `current_lane_id` | `RuntimeEventTable.lane_id` from most recent event | Lane the agent is operating in |
| `last_heartbeat_at` | Heartbeat table (tool-level SQLite) or most recent `RuntimeEventTable.time_created` | Freshest signal |
| `capabilities` | `CoordinationClaimTable.subagent_type` + role contract | Agent type determines available tools/roles |
| `error_count` | Count of `RuntimeEventTable` rows with `error_code IS NOT NULL` since last success | Rolling window |
| `last_error` | `RuntimeEventTable.error_message` from most recent error event | |
| `updated_at` | `MAX(heartbeat.time, event.time_created, claim.created_at)` | |

### Update Trigger

- `RuntimeEventTable` insert (any row with non-null `actor`)
- `CoordinationClaimTable` status change (`claimed`, `released`, `failed`)
- Heartbeat write (tool-level `heartbeat()` call in `db.ts`)
- `checkDeadlines()` expiry sweep (agents exceeding their deadline
  transition to `dead`)

### Rebuild Command

```typescript
function rebuildAgentStatusProjection(
  db: TxOrDb,
  instanceId: string,
  agentIds?: string[],
): Effect.Effect<void, DatabaseError>
```

Replays: scans `RuntimeEventTable` for all actor rows in the instance,
aggregates error counts and last-error per agent, joins against
`CoordinationClaimTable` for active claims, and cross-references the
tool-level SQLite heartbeat table for liveness.

### Staleness Policy

**Event-driven with heartbeat TTL.** The projection is refreshed on
every relevant event write. Heartbeat staleness is evaluated at read
time: if `last_heartbeat_at` exceeds the configured deadline
(`setDeadline()`), the agent is reported as `dead` even if the
projection row says otherwise. A background reconciliation sweep runs
every 30 s to catch missed transitions.

### Schema Version

**1**

### Consistency Check

```sql
-- Agents in projection without a matching runtime event actor
SELECT ap.agent_id
FROM agent_status_projection ap
LEFT JOIN (
  SELECT DISTINCT actor FROM runtime_events
  WHERE actor IS NOT NULL
    AND session_id = ap.instance_id
) re ON re.actor = ap.agent_id
WHERE re.actor IS NULL;
```

Additionally, verify that every agent with an active claim
(`status = 'claimed'` in `coordination_claim`) has
`status = 'busy'` in the projection, and that no agent has
`current_task_id` set without a corresponding claim row.

---

## 3. `context_packet_projection`

Pre-computes the working context an agent receives on each invocation:
scratchpad state, recent events, file context, and tool history. This
avoids assembling the packet from multiple tables on every agent
dispatch.

### Schema

```sql
CREATE TABLE IF NOT EXISTS context_packet_projection (
  instance_id       TEXT NOT NULL,
  packet_id         TEXT NOT NULL,
  session_id        TEXT,                    -- SessionTable.id
  scratchpad_state  JSONB,                  -- denormalised from Binder + active working memory
  recent_events     JSONB,                  -- last N RuntimeEvent rows for the lane
  working_set       JSONB,                  -- SessionTable.summary_* + file list
  file_context      JSONB,                  -- claimed files + their knowledge-graph entries
  tool_invocations  JSONB,                  -- recent tool calls from PartTable/event stream
  updated_at        BIGINT NOT NULL,
  PRIMARY KEY (instance_id, packet_id)
);
```

### Source of Truth

| Field | Canonical source | Notes |
|---|---|---|
| `instance_id` | `SessionTable.id` | Owning session |
| `packet_id` | Synthetic: `session_id:lane_id:sequence` | Stable identity for cache invalidation |
| `session_id` | `SessionTable.id` | |
| `scratchpad_state` | `Binder` (from secretary/campaign) + active working memory from `SessionTable` | Merged lane-level artifacts |
| `recent_events` | `RuntimeEventTable` | Last N rows filtered by `lane_id`; limited to avoid unbounded growth |
| `working_set` | `SessionTable.summary_*` + file list from `CoordinationReservationTable` | Summary diffs, file counts, reserved paths |
| `file_context` | `CoordinationReservationTable` paths + knowledge-graph queries (`indexFile`, `fileKnowledge`) | Claimed file metadata |
| `tool_invocations` | `PartTable.data` WHERE `type IN ('tool_call', 'tool_result')` | Recent tool interactions |
| `updated_at` | `MAX(part.time_updated, event.time_created, session.time_updated, reservation.created_at)` | |

### Update Trigger

- `PartTable` insert (new tool invocation or step-finish)
- `RuntimeEventTable` insert for the tracked lane (new event)
- `CoordinationClaimTable` or `CoordinationReservationTable` change
  (file claims shift)
- `Todo.Updated` (scratchpad working state may change)
- `SessionTable` update (summary, revert, permission changes)

### Rebuild Command

```typescript
function rebuildContextPacketProjection(
  db: TxOrDb,
  instanceId: string,
  sessionId: string,
  laneId: string,
): Effect.Effect<void, DatabaseError>
```

Replays: fetches the latest `SessionTable` row for working-set
metadata, queries the most recent N `RuntimeEventTable` rows for the
lane, pulls the `Binder` from the secretary for scratchpad state,
and joins against the knowledge-graph tables for file context.

### Staleness Policy

**Event-driven + TTL (300 s).** Refreshed on any of the five trigger
sources. A TTL ensures stale cached packets are dropped even if an
event was missed. During an active agent dispatch, the packet is
frozen as a snapshot; the projection writer skips updates for
packets whose owning agent is currently `busy`.

### Schema Version

**1**

### Consistency Check

```sql
-- Packets whose source data has changed since the projection was written
SELECT cp.packet_id
FROM context_packet_projection cp
LEFT JOIN LATERAL (
  SELECT GREATEST(
    (SELECT MAX(time_updated) FROM session WHERE id = cp.session_id),
    (SELECT MAX(time_created) FROM runtime_events WHERE lane_id = SPLIT_PART(cp.packet_id, ':', 2)),
    (SELECT MAX(time_updated) FROM part WHERE session_id = cp.session_id)
  ) AS max_source_ts
) src ON true
WHERE cp.updated_at < src.max_source_ts;
```

A non-empty result indicates a stale packet. The periodic
reconciliation sweep uses this query to identify packets needing
rebuild. The sweep runs every 60 s and refreshes any stale row.

---

## Cross-Projection Invariants

1. **`instance_id` consistency** — All three projections share the
   same `instance_id` namespace derived from `SessionTable.id`.
   There is no projection that references an unknown instance.

2. **`updated_at` monotonicity** — For every projection, `updated_at`
   never decreases across rebuilds.

3. **Primary key uniqueness** — Each projection's compound primary
   key guarantees at most one row per logical entity.

4. **No circular dependencies** — Projections are derived from
   canonical tables only, never from other projections.

---

## Projection Writer Contract

All three projections share a common write path:

```typescript
// In packages/opencode/src/session/projectors-next.ts (or similar)
interface ProjectionWriter {
  rebuild(db: TxOrDb, instanceId: string, ...scope: string[]): Effect.Effect<void>
  refresh(db: TxOrDb, event: SyncEvent): Effect.Effect<void>
  verify(db: TxOrDb, instanceId: string): Effect.Effect<string[]> // drift report
}
```

Each projection implements `rebuild` (full replay), `refresh`
(incremental update from a single event), and `verify` (consistency
check returning mismatched keys).
