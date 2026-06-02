# DuckDB Analytics Boundary

**Status:** authoritative. All contributors MUST read before adding DuckDB integration.

## Canonical Truth — Postgres/PGlite

These tables, records, and decision paths are canonical. They NEVER live in DuckDB, and
DuckDB is NEVER consulted for their content.

### Claims & Authority

- `coordination_claim` — who owns what lane, what resource, when
- All claim lifecycle events (acquire, release, expire, contest)

### Account State

- `account` — identity, credentials, capabilities
- `account_state` — active/inactive, suspension, rate-limit counters
- Account lifecycle events

### Sessions & Permissions

- Active session tokens and their associated `account_id`
- Permission grants, revocations, and capability scopes
- Session expiry and rotation records

### Migration Ledger

- Schema version history (`_migrations` or equivalent)
- Migration application timestamps and checksums
- Rollback markers

### Projection Metadata

- `_projection_meta` — what projections exist, their schema versions, last-rebuild timestamps
- Canonical source of truth for projection definitions

### Task, Lane & Agent Canonical Events

- Task creation, assignment, state transitions
- Lane creation, teardown, ownership changes
- Agent lifecycle events (spawn, complete, fail, timeout)
- All event-store entries that feed the reactive system

### Bus Messages & Event Store

- Every message published to the internal event bus
- Delivery acknowledgments and retry state
- Subscriber routing tables

### Tool Permission Decisions

- Policy evaluations for tool access
- Permission grant/deny audit log entries
- Capability resolution results

---

## DuckDB — Analytics & Debug (Disposable)

DuckDB holds **derived, read-only, disposable** data. If you delete the DuckDB file,
the system MUST be able to rebuild it entirely from Postgres/PGlite exports without
any loss of canonical information.

### Tool Latency Distributions

- Percentile histograms per tool, per agent, per lane
- Aggregated timing bucketed by hour/day

### Agent Throughput Metrics

- Tasks completed per unit time, per agent type
- Concurrency efficiency (wall-clock vs. sum-of-agent-durations)

### Event Timeline Analytics

- Time-windowed event rate graphs
- Event-type co-occurrence matrices

### Cross-Lane Comparison Reports

- Lane-A vs. Lane-B throughput, latency, error-rate side-by-sides
- Resource contention heatmaps across lanes

### Serialization Tax Measurement

- Time spent in serialize/deserialize across IPC boundaries
- Wire-size histograms per message type

### Debug Flight Recorder Export

- Dumps of recent N events (all types) for post-mortem inspection
- Time-bounded event replays in human-readable form

### Binder / Report Summaries

- Aggregated binder output summaries (claim binder, governance binder)
- Pre-computed report rollups for dashboards

### Projection Correctness Reports

- Reconstructed projection state from DuckDB compared against Postgres
- Drift detection: rows present in one store but not the other
- **Note:** correctness checks themselves read canonical data from Postgres;
  DuckDB holds the reconstructed copy being verified.

---

## Rebuild Rules

### Export Format

DuckDB projections are rebuilt from JSONL dumps of canonical Postgres/PGlite tables
and event streams. Each export is a newline-delimited JSON file with one record per
line, keyed by table or event type.

### Rebuild Command Sequence

1. Drop all DuckDB tables in the analytics schema
2. Re-import JSONL exports into fresh DuckDB tables
3. Re-run analytical materialized queries (latency histograms, throughput
   aggregates, cross-lane reports)
4. Validate row counts against export manifest

### Staleness

Every DuckDB table that derives from a Postgres export carries an `export_timestamp`
column recording when the source data was exported. Consumers MUST check this
timestamp before interpreting results as current.

### Transactional Reads

**No decision path reads from DuckDB.** DuckDB is a consumer of canonical data, never
a source of authority. Any code that branches on DuckDB query results is a bug.

---

## Guardrails

### Tool Execution Paths

- **NEVER** call `yield* DuckDB.Service` inside a tool execution path.
- Tool execution reads/writes go exclusively through Postgres/PGlite.

### Authority Decisions

- **NEVER** derive agent authority, claim validity, permission grants, or lane
  ownership from DuckDB data.
- All authority questions MUST be answered from Postgres/PGlite canonical tables.

### Projection Correctness

- **NEVER** validate projection correctness against DuckDB.
- The canonical source of truth for projections is Postgres (`_projection_meta`
  and canonical event store).

### Connection Mode

- DuckDB connections are **read-only** after the initial import phase.
- Write access is reserved for the rebuild command and initial import scripts.
- Runtime code opens DuckDB in read-only mode exclusively.

---

## Diagram

```
┌──────────────────────────────┐
│     Postgres / PGlite        │
│   Canonical Truth            │
│                              │
│  • coordination_claim        │
│  • account / account_state   │
│  • sessions / permissions    │
│  • migration ledger          │
│  • _projection_meta          │
│  • task/lane/agent events    │
│  • bus messages / event store│
│  • tool permission decisions │
└──────────┬───────────────────┘
           │
           │ JSONL export (periodic / on-demand)
           │
           ▼
┌──────────────────────────────┐
│        DuckDB                │
│   Analytics & Debug          │
│   Read-Only / Disposable     │
│                              │
│  • tool latency distributions│
│  • agent throughput metrics  │
│  • event timeline analytics  │
│  • cross-lane comparisons    │
│  • serialization tax         │
│  • flight recorder export    │
│  • binder report summaries   │
│  • projection correctness    │
│     reports (verified        │
│     against Postgres)        │
└──────────────────────────────┘
```

**Data flow is one-way:** Postgres → JSONL export → DuckDB import. DuckDB never
writes back. DuckDB never serves as an authority source for runtime decisions.
