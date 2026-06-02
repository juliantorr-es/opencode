# Query Replacement Plan: Hot Read Paths → Projections

## Overview

Three hot read paths in the agent coordination layer fire on every LLM tool call (`chat.params` and `chat.message` hooks). Each currently reads from normalised tables with deduplication subqueries or multi-table joins. Replacement projections eliminate these per-call costs by maintaining pre-computed materialised views.

| Hot Path | Hook Firing | Current Tables | Projection | Estimated Latency Reduction |
|---|---|---|---|---|
| Task Board | On-demand tool call | `lane_agents` (subquery dedup) | `task_board_projection` | 15–30ms → <1ms |
| Agent Status | `chat.params` + `chat.message` (every turn) | `journal` (×2), `lane_agents` (×2), `heartbeats` | `agent_status_projection` | 8–20ms → <1ms |
| Operating Picture | `chat.message` (every turn) | `journal` (×2) | `context_packet_projection` | 10–25ms → <1ms |

Aggregate saving per agent turn: **33–75ms**. Across a typical lane of 6 agents × ~20 turns each: **4–9 seconds** of context-building overhead eliminated.

---

## 1. Task Board

### Current Code Location

`tools/task_board.ts:28–41`

### Current Query Shape

```sql
-- Gets latest status per lane+agent (dedup via MAX(id) GROUP BY)
SELECT lane_id, agent, status, delegated_by, delegated_at, completed_at,
       auto_completed, stale_timeout, advanced_by, task
FROM lane_agents
WHERE id IN (
  SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent
)
-- Optional: AND lane_id LIKE ?
ORDER BY delegated_at DESC
```

In-memory post-processing per row (lines 56–77):
- Wave classification via `waveFor(agent)` — maps agent name to lifecycle phase
- Staleness detection: `age > 300s` and status `"pending"` → `stale`
- Sorting, filtering into `pending`/`completed`/`failed`/`stale` buckets
- Wave summary aggregation

### Replacement Projection

`task_board_projection` — a single-row-per-agent projection that materialises the deduped, classified state.

**Schema:**

| Column | Type | Source |
|---|---|---|
| `lane_id` | TEXT | `lane_agents.lane_id` |
| `agent` | TEXT | `lane_agents.agent` |
| `status` | TEXT | Derived: `"pending"` / `"completed"` / `"failed"` / `"stale"` |
| `wave` | TEXT | Pre-computed via `waveFor(agent)` |
| `delegated_by` | TEXT | `lane_agents.delegated_by` |
| `delegated_at` | TEXT | `lane_agents.delegated_at` |
| `completed_at` | TEXT | `lane_agents.completed_at` |
| `task` | TEXT | `lane_agents.task` |
| `elapsed_seconds` | INTEGER | `(now - delegated_at)` in seconds |
| `updated_at` | TEXT | Row last refreshed timestamp |

**Read query:**

```sql
SELECT * FROM task_board_projection
-- Optional: WHERE lane_id LIKE ?
ORDER BY delegated_at DESC
```

No in-memory wave classification, no staleness computation, no bucket filtering — all pre-materialised.

### Expected Latency Reduction

| Phase | Before | After |
|---|---|---|
| SQL query | 10–20ms (subquery dedup + scan) | <0.5ms (single table scan) |
| In-memory processing | 5–10ms (wave classify + sort + bucket) | 0ms |
| **Total** | **15–30ms** | **<1ms** |

### Correctness

The projection **matches canonical** when refreshed atomically after every `lane_agents` write:
- `announce_lane_before_using_task_to_invoke_the_subagent` (INSERT pending)
- `leaf_handoff` (INSERT completed/failed)
- Auto-complete stale agents (UPDATE + INSERT auto_completed rows)

Edge cases the projection MUST handle:
- Staleness is time-dependent (`age > 300s`). The projection writer refreshes the `status` and `elapsed_seconds` columns on every tick or on read. If a read occurs between writes and the clock crosses 300s, the projection is 1 tick stale → acceptable for a dashboard.
- Wave classification is deterministic (string matching on agent name). No correctness risk.

### Staleness Detection

- **Source of truth reconciliation**: The projection stores a `lane_id` + `agent` + `MAX(id)` watermark. On read, compare against `SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent`. If any newer `id` exists, re-derive that row.
- **Time-driven staleness**: `elapsed_seconds` and `status: "stale"` are re-evaluated on every read by the projection writer (atomic UPDATE before SELECT). The projection reader never computes staleness itself.
- **TTL**: A `lane_agents` row older than 300s with `status = "pending"` is marked `"stale"` in the projection by the writer, not inferred by the reader.

---

## 2. Agent Status

### Current Code Location

`plugin.ts:51–68` (`inferPhase`), `plugin.ts:70–102` (`hiveMemory`), `plugin.ts:104–125` (`peerHealth`), `plugin.ts:241–259` (loop detection heartbeat query)

These fire in two hooks on **every LLM turn**:
- `chat.params` (line 211–221): calls `inferPhase`
- `chat.message` (line 291–330): calls `inferPhase`, `hiveMemory`, `buildContext`, `checkDeadlines`, `peerHealth`
- `tool.execute.before` (line 241–259): loop detection heartbeat query

### Current Query Shape

**inferPhase** (50–68):
```sql
SELECT tool FROM journal WHERE agent = ? ORDER BY created_at DESC LIMIT 5
-- In-memory: count explore vs execute tools in last 5 entries
```

**hiveMemory** (70–102):
```sql
-- Query 1: recent files
SELECT files_touched, created_at FROM journal
WHERE agent = ? AND files_touched IS NOT NULL
ORDER BY created_at DESC LIMIT 3

-- Query 2: recent discoveries
SELECT summary, created_at FROM journal
WHERE agent = ? AND summary IS NOT NULL AND summary != ''
ORDER BY created_at DESC LIMIT 3

-- In-memory: forgettingCurve(age) filter, string truncation
```

**peerHealth** (104–125):
```sql
SELECT agent, status, delegated_at,
  CAST((julianday('now') - julianday(delegated_at)) * 86400 AS INTEGER) as age_seconds
FROM lane_agents
WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
  AND lane_id = ? AND agent != ?
ORDER BY delegated_at DESC LIMIT 8
```

**checkDeadlines** (db.ts:59–67, called at plugin.ts:309):
```sql
SELECT agent, status, delegated_at, deadline_at,
  CAST((julianday('now') - julianday(deadline_at)) * 86400 AS INTEGER) as overdue_seconds
FROM lane_agents
WHERE id IN (SELECT MAX(id) FROM lane_agents GROUP BY lane_id, agent)
  AND lane_id = ? AND status = 'pending'
  AND deadline_at IS NOT NULL AND deadline_at < datetime('now')
```

**Loop detection heartbeat** (plugin.ts:247–252):
```sql
SELECT COUNT(*) as cnt FROM heartbeats
WHERE session_id = ? AND tool = ? AND detail LIKE ?
  AND at > datetime('now', '-2 minutes')
```

### Replacement Projection

`agent_status_projection` — one row per active agent, covering phase, hive memory, peer health, and deadlines in a single read.

**Schema:**

| Column | Type | Source |
|---|---|---|
| `agent` | TEXT | — (PK) |
| `lane_id` | TEXT | `lane_agents.lane_id` (latest) |
| `phase` | TEXT | `"explore"` / `"execute"` — pre-computed from last 5 journal entries |
| `hive_files` | TEXT | Comma-separated recent file paths, forgetting-curve filtered |
| `hive_discoveries` | TEXT | Pipe-separated recent summaries, forgetting-curve filtered |
| `status` | TEXT | `"pending"` / `"completed"` / `"failed"` / `"stale"` |
| `age_seconds` | INTEGER | Seconds since `delegated_at` |
| `deadline_overdue_seconds` | INTEGER | NULL or seconds past deadline |
| `recent_tool_count_2m` | INTEGER | Heartbeat count in last 2 minutes (loop detection) |
| `updated_at` | TEXT | Row last refreshed timestamp |

**Read query (single call replaces 6+ queries):**

```sql
SELECT * FROM agent_status_projection
WHERE lane_id = ? AND agent != ?
ORDER BY delegated_at DESC LIMIT 8
```

The `chat.params` hook reads only the `phase` column for the current agent. The `chat.message` hook reads the full row for all peers in the lane.

### Expected Latency Reduction

| Phase | Before | After |
|---|---|---|
| `chat.params`: inferPhase | 3–5ms (journal query + in-memory) | <0.5ms (single column read) |
| `chat.message`: hiveMemory | 5–10ms (2 journal queries + forgettingCurve) | <0.5ms (pre-computed columns) |
| `chat.message`: peerHealth | 5–10ms (dedup subquery + julian calc) | <0.5ms |
| `chat.message`: checkDeadlines | 3–5ms (dedup subquery + julian calc) | <0.5ms |
| `tool.execute.before`: loop detection | 2–5ms (heartbeat count) | <0.5ms |
| **Total per turn** | **8–20ms** (unbatched: up to 35ms) | **<1ms** (single batched read) |

### Correctness

The projection **matches canonical** when:
- `inferPhase`: The projection writer replays the same 5-journal-entry window and counts explore/execute tools identically. No correctness risk — the algorithm is deterministic string-set membership.
- `hiveMemory`: `forgettingCurve(age)` is deterministic (`0.5^(age/3600)`). The projection writer applies the same curve, same thresholds (0.15 for files, 0.3 for discoveries). Identical output.
- `peerHealth`: Same dedup logic as task board. `age_seconds` uses the same `julianday` calculation. Identical output.
- `checkDeadlines`: Same dedup + `julianday` calculation. Identical output.
- Loop detection: Same `datetime('now', '-2 minutes')` window. The projection writer updates `recent_tool_count_2m` on every heartbeat write, so the count is at most 1 write behind. Acceptable for loop detection (threshold is ≥3; 1-count lag cannot cause false positive).

### Staleness Detection

- **Write-triggered refresh**: Every `heartbeat()`, `logToolUsage()`, `journal` INSERT, `lane_agents` INSERT, and `setDeadline()` triggers an incremental refresh of the affected agent's row in the projection.
- **Time-decay refresh**: `hive_files` and `hive_discoveries` use `forgettingCurve(age)` which decays with wall-clock time. The projection writer re-evaluates these on every read (UPDATE before SELECT) to keep them fresh without a background ticker.
- **Watermark check**: On query, if `updated_at < MAX(heartbeats.at, journal.created_at, lane_agents.id)` for the agent, re-derive the row.

---

## 3. Operating Picture (Context Packet)

### Current Code Location

`plugin.ts:127–158` (`buildContext`), `plugin.ts:337–341` (compaction hook)

These fire on **every LLM turn** in `chat.message` and on session compaction.

### Current Query Shape

**buildContext** (127–158):
```sql
SELECT agent, tool, summary, created_at, files_touched
FROM journal WHERE lane_id = ?
ORDER BY created_at DESC LIMIT 20
```
In-memory post-processing:
- Score each entry: +5 if same agent, +5 if age < 120s, +3 if age < 600s, +3 if summary matches `/finding|blocker|error|bug|fail/i`
- Filter: keep only entries with score > 3
- Sort by score descending, take top 8
- Format as string with icons

**Compaction hook** (337–341):
```sql
SELECT tool, summary FROM journal
WHERE lane_id = ? AND agent = ?
ORDER BY created_at DESC LIMIT 3
```

### Replacement Projection

`context_packet_projection` — pre-scored, relevance-filtered, formatted context packet.

**Schema:**

| Column | Type | Source |
|---|---|---|
| `lane_id` | TEXT | — (PK) |
| `context_text` | TEXT | Pre-formatted "📊 RECENT:" block with scored entries |
| `context_agent` | TEXT | Agent the context was last built for (can be stale) |
| `context_score` | INTEGER | Sum of entry scores (heuristic for "how interesting") |
| `compaction_text` | TEXT | Pre-formatted compaction line for the current agent |
| `journal_watermark_id` | INTEGER | MAX(journal.id) when this packet was built |
| `updated_at` | TEXT | Row last refreshed timestamp |

**Read query:**

```sql
SELECT context_text, compaction_text
FROM context_packet_projection
WHERE lane_id = ?
```

The `chat.message` hook reads `context_text`; the compaction hook reads `compaction_text`. No in-memory scoring, filtering, sorting, or formatting.

### Expected Latency Reduction

| Phase | Before | After |
|---|---|---|
| `chat.message`: buildContext | 10–20ms (journal query + scoring loop + formatting) | <0.5ms (single row read) |
| Compaction hook | 2–5ms (journal query + formatting) | <0.5ms |
| **Total per turn** | **10–25ms** | **<1ms** |

### Correctness

The projection **matches canonical** when the writer applies the same scoring algorithm:
1. Fetch last 20 journal entries for the lane
2. Score each identically: `(same_agent ? 5 : 0) + (age < 120 ? 5 : age < 600 ? 3 : 0) + (summaryRegex ? 3 : 0)`
3. Filter `score > 3`, sort by score desc, slice top 8
4. Format with icons: `score ≥ 10 → 🔴`, `score ≥ 6 → 🟡`, else `🟢`

Edge cases:
- `context_text` is agent-relative: same-agent bonus depends on who is reading. The projection stores the most recent agent's context. When a different agent reads, the scores shift — the projection writer MUST rebuild on agent change.
- The compaction hook queries a specific agent (`lane_id = ? AND agent = ?`), not all entries in the lane. The projection's `compaction_text` is per-agent, not per-lane.

**Decision**: The projection stores a `context_text` keyed by `(lane_id, agent)` — one row per agent-in-lane, not one per lane. This avoids the agent-relative scoring problem.

### Staleness Detection

- **Watermark**: `journal_watermark_id` compared against `MAX(journal.id) WHERE lane_id = ? AND agent = ?`. If watermark is behind, rebuild.
- **Write-triggered refresh**: Every `journal` INSERT in `tool.execute.after` (plugin.ts:277–284) triggers a context packet rebuild for the affected `(lane_id, agent)`.
- **Score decay**: Entry scores use `age` which is wall-clock relative. The projection writer re-evaluates on every read (UPDATE before SELECT) to keep scores current.
- **Compaction text**: Rebuilt on write or on read if `journal_watermark_id` is stale.

---

## Projection Maintenance Strategy

### Write-Triggered Refresh

All three projections are refreshed synchronously in the write path. This ensures read-after-write consistency:

| Write Event | Projections Refreshed |
|---|---|
| `announce_lane` (INSERT lane_agents) | `task_board_projection`, `agent_status_projection` |
| `leaf_handoff` (INSERT lane_agents) | `task_board_projection`, `agent_status_projection` |
| Auto-complete stale (INSERT + UPDATE lane_agents) | `task_board_projection`, `agent_status_projection` |
| `setDeadline` (UPDATE lane_agents) | `agent_status_projection` |
| `heartbeat` (INSERT heartbeats) | `agent_status_projection` |
| `journal` INSERT (from `tool.execute.after`) | `agent_status_projection`, `context_packet_projection` |

### Read-Time Refresh

Time-dependent columns (`elapsed_seconds`, `status` for staleness, `forgettingCurve` scores) are re-evaluated on read via `UPDATE projection SET ... WHERE ...` before `SELECT`. This avoids a background ticker.

### Atomicity

All projection writes use SQLite transactions. A write that touches `lane_agents` + `task_board_projection` + `agent_status_projection` does so in a single `BEGIN IMMEDIATE … COMMIT` to prevent torn reads.

---

## Migration Path

1. **Create projection tables** (DDL in `db.ts:ensureTables`)
2. **Add projection writer functions** (new file `tools/projections.ts`)
3. **Wire write triggers** — add projection refresh calls to every existing write path
4. **Add read-side fallback** — projection readers check watermark; if stale, fall back to canonical query (then rebuild projection in background)
5. **Switch hot paths** — replace `plugin.ts` hook queries with projection reads
6. **Remove fallback** — once projections are proven stable, remove canonical query fallback code

The fallback in step 4 ensures zero-downtime migration: if a projection is ever stale or missing, the old query path is still available.
