# ADR 003: PGlite + Valkey + DuckDB Data Architecture

## Status
Accepted — June 2026

## Context

Tribunus requires three distinct runtime capabilities that no single database provides:

1. **Durable intelligence** — The Codex (diagnostic packets, dharma ledger, packet provenance, vector embeddings) must survive restarts, support transactional writes, and serve local-first reactive queries.
2. **Live coordination** — Multiple agents and humans need real-time shared state: who is working on what, queue prioritization, diff streams, presence.
3. **Retrospective analysis** — The system must answer product questions: which packet families propagate fastest, which frameworks produce repeated failures, which agent routes produce bad matches.

SQLite was the initial local store. It was replaced with PGlite for vector search (`pgvector`), JSON document support (`JSONB`), and extension capabilities. Valkey was added for distributed coordination. DuckDB was added for columnar analytics. This ADR defines the contract between them.

## Decision

### PGlite — Local Durable Intelligence

PGlite owns all durable state. Nothing in Valkey or DuckDB is authoritative.

**What lives here:**
- Diagnostic packets (JSONB documents with full schema)
- Dharma ledger (ACID transactions for every point earned or spent)
- GitHub identity mappings
- Packet provenance and confirmation chains
- Packet status lifecycle (proposed → confirmed → propagated → superseded → deprecated)
- Vector embeddings for symptom signatures (`pgvector` with HNSW indexing)
- Full-text search vectors (`pg_textsearch` with BM25 ranking)
- Local codex storage (persisted to filesystem via Bun/Node APIs)

**Reactivity model:** PGlite's `live` query extension, not `LISTEN/NOTIFY`. Live queries let the desktop app cockpit subscribe to a SQL query and receive updated results when underlying tables change. This is the product-native primitive for "the Codex updated → refresh the UI."

**Why not LISTEN/NOTIFY:** In standard Postgres this is the right pattern for waking distributed workers. In PGlite's WASM single-user model, live queries are the correct local reactivity primitive. Distributed wake-up is Valkey's job.

### Valkey — Live Coordination Layer

Valkey owns shared, ephemeral, coordination-heavy state. Nothing in Valkey is authoritative — all durable truth lives in PGlite.

**Streams (with consumer groups) for processing rails:**
- Agent work queues (diagnostic packet submission, disclosure approval, dharma receipt issuance)
- Consumer groups allow multiple agent instances to claim work without duplication
- Pending-message inspection for detecting stuck work
- Claiming unprocessed messages for reassigning abandoned work
- Acknowledgments for completion guarantees
- History visibility for replay and debugging

**Sorted sets for the community queue:**
- Members ordered by dharma-weighted priority
- Priority = BaseUrgency × DharmaScore × MatchRelevance × RecencyOfContribution
- Atomic score updates for dharma adjustments
- Range queries for priority-ordered dequeuing

**Pub/sub (at-most-once) for volatile UI events:**
Only for events where loss is acceptable — no audit trail needed, no durable state involved.
- "Agent X is typing"
- "Lane C updated"
- "New packet candidate available" (notification only, the packet itself is in PGlite)
- "Refresh this panel" (hint, not command)

**The boundary rule:** If the event must be durable, it writes to PGlite first and Valkey Streams is the processing rail. If the event is live presence or a volatile UI hint, pub/sub is acceptable. If the event is "this human must see this and it matters," neither — it goes through the coordination fabric's evidence pipeline.

### DuckDB — Analytical Reflection Layer

DuckDB does not own product state. It consumes snapshots and events from the other two layers.

**What DuckDB answers:**

| Question | Source Data |
|----------|-------------|
| Which packet families propagate fastest? | PGlite confirmation chains |
| Which frameworks produce the most repeated failures? | PGlite packet environment shapes |
| Which dharma signals correlate with merged PRs? | PGlite dharma ledger + GitHub PR data |
| Which codex entries are going stale? | PGlite packet age + last propagation date |
| Which agent routes produce bad matches? | Valkey Stream consumer group metrics |
| Community growth trends | PGlite identity mappings over time |

DuckDB's Node.js client supports embedded analytical use. Queries run against in-memory or file-backed databases, not against the transactional store directly. This is the Lovable retrospective learning loop, made inspectable and local-first.

## Consequences

### Positive
- **No category errors.** PGlite is not abused as a coordination bus. Valkey is not abused as durable truth. DuckDB is not abused as the operational store.
- **Extension leverage.** pgvector, pg_textsearch, pg_trgm all run inside PGlite without separate services.
- **Local-first.** The full Codex and all analytical queries run on the desktop machine. No cloud dependency for core product function.
- **Clean scaling path.** When team mode ships, Valkey already handles distributed coordination. PGlite instances sync via ElectricSQL (hub-and-spoke today, P2P on the roadmap). DuckDB queries scale to analytical workloads without impacting transaction latency.
- **Provenance is transactional.** Every dharma point, packet confirmation, and status transition is an ACID transaction in PGlite. The evidence ring is not a separate system — it's a materialized view over the transaction log.

### Negative
- **Three databases to maintain.** Each has its own upgrade path, version pinning, and operational surface.
- **WASM size.** PGlite (~3MB gzipped) + Valkey (~3.5MB binary) + DuckDB (~15MB) = ~21MB of embedded database. Acceptable for a desktop app, not for a web app.
- **PGlite is young.** Single-user WASM mode limits multi-connection scenarios. ElectricSQL sync is in active development. Some PG extensions are incompatible due to WASM/pgrx limitations.
- **No P2P database sync yet.** ElectricSQL is hub-and-spoke today. True P2P sync between PGlite instances is on the roadmap but not shipped. In the interim, the coordination fabric handles P2P message routing and PGlite is the local sink.

## References
- PGlite: https://pglite.dev — WASM Postgres with extension support
- pgvector: https://github.com/pgvector/pgvector — Vector similarity search for Postgres
- Valkey: https://valkey.io — Redis-compatible coordination database
- DuckDB: https://duckdb.org — Embedded columnar analytical database
- ElectricSQL: https://electric-sql.com — Sync engine for local-first Postgres
