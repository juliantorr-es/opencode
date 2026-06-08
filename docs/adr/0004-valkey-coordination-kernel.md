# ADR 004: Valkey as Coordination Kernel

## Status
Accepted — June 2026

## Context

ADR 003 established the data layer split: PGlite for durable intelligence, Valkey for live coordination, DuckDB for analytical reflection. This ADR defines the specific contract for Valkey within that architecture — what it owns, what it does not own, and the primitives it exposes.

The problem: distributed coordination tends to produce async spaghetti. Every subsystem invents its own lock, its own retry timer, its own debounce logic, its own "wait until X is ready" glue. These accumulate across agent orchestration, mission scheduling, dharma queueing, packet disclosure, and PR generation. The result is ungovernable.

The insight: Valkey's single-threaded sequential execution model gives it a unique property — it can **serialize coordination** without **serializing execution.** All authority-changing events run through Valkey in order. All expensive work runs outside Valkey in parallel.

## Decision

### The Conductor Model

Valkey is the conductor. It decides the next move. Workers perform the move. PGlite records the receipt. Valkey advances the state machine.

```
┌─────────────────────────────────────────────────────┐
│                    PGlite                            │
│  Durable memory: packets, dharma, receipts,         │
│  provenance, scheduled obligations, execution logs  │
└──────────────────┬──────────────────────────────────┘
                   │ record receipt
                   │
┌──────────────────▼──────────────────────────────────┐
│                    Valkey                            │
│  Coordination kernel: claims, leases, transitions,  │
│  gates, queue priorities, heartbeats, retry timing  │
│                                                     │
│  Streams ─── work queues with consumer groups       │
│  Sorted Sets ─ priority scheduling + due-time wheel │
│  Keys (TTL) ─ heartbeats + leases                   │
│  Pub/sub ─ volatile UI signals only                 │
└──────────────────┬──────────────────────────────────┘
                   │ claim work, report completion
                   │
┌──────────────────▼──────────────────────────────────┐
│                   Workers                            │
│  Agents, file readers, LLM calls, test runners,      │
│  patch generators, GitHub API, DuckDB queries        │
│                                                     │
│  Async, parallel, uncontrolled — but gated by Valkey │
└─────────────────────────────────────────────────────┘
```

### Primitives and Their Contracts

**Streams — Work Queues**

Every mission, packet submission, disclosure approval, gate check, and PR generation becomes a stream entry.

- Consumer groups (`XGROUP CREATE`) ensure multiple workers don't duplicate work
- Pending inspection (`XPENDING`) detects stuck workers
- Claiming (`XCLAIM`) reassigns abandoned work
- Acknowledgment (`XACK`) confirms completion
- History visibility (`XRANGE`) enables replay and debugging

Bad: running the LLM call inside the stream consumer. Good: the stream entry says "packet abc-123 needs disclosure review." A worker claims it, runs the LLM call, writes the result to PGlite, and XACKs the stream entry.

**Sorted Sets — Priority Scheduling + Timing Wheel**

Two scheduling concerns, one data structure.

Priority queue for the community support queue: score = `BaseUrgency × DharmaScore × MatchRelevance × RecencyOfContribution`. Workers poll `ZRANGEBYSCORE` for the next item. `ZINCRBY` adjusts priority when dharma changes.

Due-time wheel for timed obligations: score = Unix timestamp of next execution. Workers poll for scores ≤ now. Claim with a lease (TTL key). On completion, remove from sorted set and insert next occurrence at now + interval. This replaces all ad-hoc `setTimeout` / `setInterval` / `cron` scattered across the app with one centralized scheduler.

**TTL Keys — Heartbeats + Leases**

Agent heartbeats: `SET agent:heartbeat:<agentId> "alive" EX 30`. If the key disappears, the supervisor knows the agent is stale.

Work leases: `SET lease:<taskId> <workerId> EX 60 NX`. Only one worker gets the lease. Renew with `EXPIRE` mid-work. If the lease expires, another worker can claim via `SET NX`.

**Pub/sub — Volatile UI Signals Only**

`PUBLISH cockpit:agent:typing` — fine. `PUBLISH dharma:receipt:issued` — wrong, that's a PGlite write with a Valkey Stream notification. The rule: if the event matters after a restart, it is not pub/sub material.

### The Authority Boundary

This is the rule that prevents Valkey from becoming a hidden second database:

> Anything you cannot reconstruct after a Valkey wipe does not belong only in Valkey. Treat Valkey as a projection, coordination bus, and timing rail. Treat PGlite as memory.

**What Valkey owns:**
- Order of authority-changing events (serialized via MULTI/EXEC or Lua scripts)
- Who owns what work right now (leases)
- What should happen next (sorted set scores)
- What is past due (due-time wheel with scores ≤ now)
- Who is alive (TTL heartbeats)
- Where work is in the pipeline (stream consumer group state)

**What Valkey does not own:**
- The durable record of what happened (PGlite)
- The evidence that something was done (PGlite)
- The dharma ledger (PGlite ACID transactions)
- The packet content (PGlite JSONB)
- The audit trail (PGlite)

**Recovery protocol:** If Valkey restarts, the app rebuilds the scheduling projection from PGlite. Every scheduled obligation has a durable record. Every lease state can be reconstructed from the stream consumer group state. Every priority score can be recomputed from the dharma ledger. Valkey is fast because it can be fast — it never needs to be durable.

### Timing Discipline

The combination of sorted set due-time wheel + TTL leases + consumer group recovery gives Tribunus a property most agent systems lack: **temporal discipline.**

Not just "agent did something" — but "agent did the right thing within the allowed window, under a lease, with evidence, and with recovery if it failed."

This matters for the enterprise roadmap. A compliance-ready audit trail requires knowing not just what happened, but when it was supposed to happen, when it actually happened, and whether the delta was within policy.

### What Gets Replaced

All of this ad-hoc coordination code disappears from the app:

| Removed | Replaced By |
|---------|-------------|
| `setTimeout` / `setInterval` for retries | Sorted set due-time wheel |
| Promise-based debounce/race logic | Stream consumer group `XPENDING` + `XCLAIM` |
| In-process lock objects | TTL lease keys |
| Polling loops for "is X ready yet" | Stream blocking reads (`XREAD BLOCK`) |
| Custom heartbeat/ping protocols | TTL heartbeat keys |
| Priority queue implementations | Sorted sets with `ZRANGEBYSCORE` |
| Custom scheduler/cron modules | Sorted set due-time wheel |

The coordination code becomes: "write to PGlite, project to Valkey, consume from Valkey, XACK when done, write receipt to PGlite." Every subsystem follows this pattern. No subsystem invents its own coordination.

## Consequences

### Positive
- **Single coordination spine.** All authority-changing events go through Valkey. No ad-hoc coordination scattered across the app.
- **Recovery without fragility.** Valkey can lose everything and the system rebuilds from PGlite. No data loss, only temporary coordination pause.
- **Temporal discipline.** Deadlines, heartbeats, retries, and SLAs are first-class citizens, not afterthoughts.
- **Worker model is clean.** Consumer groups give you exactly the right primitives: claim, process, acknowledge, recover. No custom queue implementation needed.
- **Testable.** The coordination kernel can be tested in isolation. Workers can be mocked. The scheduler projection rebuild can be verified against PGlite state.

### Negative
- **Single point of coordination.** If Valkey goes down, coordination pauses. Workers continue running but can't claim new work or report completion. Mitigation: Valkey is co-located with the app (embedded binary), so failure is correlated with app failure.
- **Learning curve.** Consumer groups, sorted set scheduling, TTL lease patterns are not obvious to developers used to async/await and in-process coordination.
- **Projection consistency.** The PGlite → Valkey projection must stay consistent. If a scheduled obligation is in PGlite but not in Valkey, it never fires. If it's in Valkey but not PGlite, it has no audit trail. The rebuild-on-restart protocol must be exercised regularly.

## Operational Guidance: Persistence and Recovery

### The Blackboard Metaphor

Valkey is the blackboard in a war room. Everyone sees it, updates are ordered, coordination is fast. The official record is still written in the ledger (PGlite). If someone wipes the blackboard, you rebuild it from the ledger and continue.

The risk model: **Valkey loss should be annoying, not catastrophic.**

Acceptable to lose: live presence, active leases, pending ephemeral queues, heartbeat state, in-flight UI notifications, short-lived scheduling projections.

Not acceptable to lose: codex packets, dharma receipts, human approvals, disclosure history, mission receipts, gate decisions, PR provenance, compliance/audit events.

### Persistence Configuration

For local desktop operation, Valkey is configured with AOF (Append-Only File) enabled:

```
appendonly yes
appendfsync everysec
```

`appendfsync everysec` means at most one second of Valkey writes are lost in a crash. This is the right tradeoff for a desktop app — performance remains high, and the one-second window is acceptable because anything critical is also written to PGlite before the user-visible action completes.

For strict evidence mode (enterprise compliance), `appendfsync always` is available but trades write latency for per-operation durability. This should be a user-configurable policy, not a default.

### Recovery Protocol

If Valkey state is lost (restart, eviction, data directory misconfiguration, user deletion of app support files, installer migration, path change, development reset), Tribunus runs a rebuild step:

1. Scan PGlite for open missions, unclosed leases, pending gates, scheduled obligations, unacknowledged packet work, and unfinished PR proposals
2. Repopulate Valkey queues (Streams), scheduler (Sorted Sets), and heartbeat state (TTL keys)
3. Display a recovery banner: "Coordination state rebuilt — all history is intact"
4. Resume normal operation

The system never loses history. It may lose a few seconds of coordination progress, which is automatically recovered when workers reclaim stream entries and the scheduler replays due obligations.

### The Rebuild Is Not a Disaster Recovery Drill

It is a normal operational path. It runs on every cold start (Valkey process not running), not just after crashes. The rebuild protocol must be fast (< 1 second for typical state) and idempotent (running it twice against the same PGlite state produces the same Valkey projection).

### Wipe Scenarios That Must Be Handled

| Scenario | Recovery |
|----------|----------|
| Valkey started with `--save ""` (no persistence) | Rebuild from PGlite on start |
| User deletes app support directory | Rebuild from PGlite on start |
| Installer migration changes data paths | Rebuild from PGlite on start |
| Dev reset script nukes state | Rebuild from PGlite on start |
| Machine crash before AOF fsync | Replay AOF on restart (lose ≤ 1s); rebuild remainder from PGlite |
| Valkey binary upgrade | AOF replay; no rebuild needed |

## References
- Valkey Streams: https://valkey.io/topics/streams-intro/ — Consumer groups, pending entries, claiming
- Valkey Sorted Sets: https://valkey.io/commands/zadd/ — Priority scheduling and timing wheels
- Valkey Transactions: https://valkey.io/topics/transactions/ — MULTI/EXEC for serialized state transitions
- ADR 003: PGlite + Valkey + DuckDB Data Architecture
