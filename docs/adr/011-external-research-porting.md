# External Architecture Research — Porting Analysis

## Rig Relay (550-schema mission-governed codebase)

Rig Relay is a Python 3.12+ desktop coding assistant with a 550-schema governance architecture, fleet coordination plane, tamper-evident audit trail, and DuckDB analytical substrate. The architectural patterns are directly portable to Tribunus.

### Concepts to Port — Urgent (Foundation)

**1. Schema-First Architecture with `additionalProperties:false`**

550+ typed JSON schemas. Every artifact — events, decisions, receipts, projections, patches, leases, missions — has a canonical schema. Every schema has `additionalProperties: false` at every nesting level. Forbidden field names are explicitly banned (`prompt`, `stdout`, `stderr`, `content`, `diff`, `patch`, `secret`, `argv`, `snippet`).

Port to Tribunus: Diagnostic packets, dharma receipts, codex entries, design council verdicts, mission descriptors — everything gets a canonical schema. Effect Schema (already in the repo) as the implementation substrate.

**2. Content-Light Doctrine**

Fleet queue items carry only summary text, hashes, and refs. Never raw prompts, stdout, stderr, content, diffs, patches, secrets. `PatchProposal` stores `touched_paths`, hashes, and `artifact_refs` — never embedded diffs. Projection models have `ConfigDict(extra="forbid")`.

Port to Tribunus: Diagnostic packets reference commit hashes, not full diffs. Error signatures are hashed stack traces, not raw call stacks. File involvement is paths, not contents. This maps to the privacy/disclosure gate from the Codex spec.

**3. Append-Only Event Sourcing**

Fleet queue is append-only JSONL. Current state derived by replaying events. No mutation, no deletion. Every event has `event_id`, `schema_version`, `created_at`, `parent_event_id`. `FleetQueueSnapshot` is a disposable derived projection.

Port to Tribunus: Dharma ledger as append-only JSONL. Codex entry lifecycle (proposed → confirmed → propagated → superseded) as event-sourced. Evidence ring replays events to reconstruct state. PGlite stores canonical records; Valkey projects for live queries.

**4. Canonical Evidence Authority**

"Schema-validated evidence artifacts are the absolute authority for governed transitions. Append-only ledgers are immutable. Derived projections and UI state are disposable and MUST be reconstructable from canonical evidence. If a governed decision is not recorded in its canonical evidence domain, it did not happen."

Port to Tribunus: This is the PGlite/Valkey authority boundary from ADR 004. PGlite is canonical evidence. Valkey is a disposable projection. Rebuild-on-restart is this principle in practice.

**5. Fleet Coordination Plane — Path Leases**

Path-level coordination: exclusive write leases, shared read leases, TTL heartbeats, stale lease recovery. "Agents propose; orchestrator disposes." The orchestrator is the only entity with mutation authority for shared files.

Key primitives: `claim_paths`, `release_paths`, `renew_lease`, `query_claims`, `submit_patch`, `request_review`, `mark_done`, `report_blocker`. Lease TTL with heartbeat expiry. Idempotent operations based on `event_id`.

Port to Tribunus: Multi-agent file coordination. Agents hold TTL leases on codebase paths. Orchestrator (senior engineer console) owns mutation authority. File conflicts detected via lease overlap and blocked with `ConflictNotice`.

**6. Fleet Queue — Event-Sourced Work Dispatch**

Append-only event-sourced queue with typed item kinds: `message`, `runtime_exec`, `validate`, `handoff_note`, `pause`, `resume`. State machine: QUEUED → RUNNING → COMPLETED/FAILED/BLOCKED/CANCELLED. Ordering rules: highest priority first, FIFO within priority, deterministic tiebreaker. Content-light: queue items never contain raw content.

Port to Tribunus: The Valkey Stream consumer group model from ADR 004 already implements this pattern. The queue item state machine and ordering rules are the specification for Valkey Stream processing.

**7. Claim-Adversary Pass**

"Before reporting completion, run a short hostile review against the exact status you intend to publish. Treat every noun and adjective as an assertion to falsify. Attack authority ownership, production-boundary realism, crash/retry safety, canonical evidence reconstruction, remote publication truth, and lane-boundary release safety."

Port to Tribunus: Add as a specialized critic in the design council. Receives mutation + agent claim. Attempts to falsify every assertion. Falsification success → downgrade or reject.

**8. Tamper-Evident Audit Trail**

Three-layer design: event hash chain (each event hashes itself + predecessor), checkpoint records (periodic batch with chain head hash + Merkle root), external anchoring (future signing/TSA/remote witness). Never auto-repair. Never silently rewrite. Report exact break location.

Port to Tribunus: Evidence ring for dharma ledger and codex provenance. Every receipt links to predecessor via hash chain. Every codex confirmation produces a checkpoint record. Tamper evidence is detectable as long as one party retained a checkpoint root.

### Concepts to Port — After Foundation

**9. Prepublication Review Loop**

Builder → Reviewer → admission. Reviewer emits only: `prepublication_admitted`, `prepublication_repair_required`, `prepublication_blocked_external_dependency`. Review report is append-only. Builder may not rewrite. Builder must repair blocking findings and resubmit.

Port to Tribunus: The design council critic loop as a formal protocol. After critics evaluate mutation, architect receives structured feedback. Either repairs or declares external blocker. No silent rejection.

**10. Lane Closure & Freeze Doctrine**

A lane is complete when its explicit boundary is published, production-proven, reconstructable from evidence, defect-free inside that boundary. Deferred gaps don't keep lane open unless they make boundary unsafe. Claim-adversary pass verifies. Once remotely verified, lane freezes pending named integration milestone. Frozen lanes reopen only for concrete defect, named integration milestone, or user-directed architectural revision.

Port to Tribunus: Cartographer → architect → critic loop closure model. A design surface migration completes when declared boundary is rendered, tested, evidence-backed, defect-free. Undiscovered issues in other form factors don't block closure. Lane freezes. Next milestone opens.

**11. Storage Budget & Retention Policy**

`artifact_gc.py` implements lifecycle with retention rules. `storage_audit.py` tracks actual vs. budget. Content-aware GC policies.

Port to Tribunus: Local codex storage management. Storage budgets prevent unbounded growth. GC policies based on age, propagation count, status. Audited, not silent.

**12. DuckDB Analytics Projection**

Append-only JSONL source, DuckDB for retrospective queries. `ModelRows`: structured LLM call records. `BashRows`: sandboxed shell telemetry. `GovernanceDecisionsProjection`: governance decisions with domain/scope/correlation. Content-light projection compiler.

Port to Tribunus: The DuckDB analytical layer from ADR 003. Lovable retrospective learning loop — which packets propagate, which frameworks produce failures, which agent routes produce bad matches.

### Concepts to Study

**13. Ralph Scanner — Observe-Only Surface Mapping**

Read-only scanner: produces projection input, mission candidates, ranking without mutating. "Observe, don't touch."

Port concept: The cartographer in the design council. Before proposal, read-only scanner maps current surface. Then architect proposes.

**14. Operational Picture & Provider Registries**

Live-readiness reports, capability matrices, provider compatibility profiles, auth state projections. "Before acting on a provider, verify reachable, authenticated, within capacity envelope."

Port concept: LLM provider readiness before spawning agent fleet. Verify backends reachable, rate-limited, within latency SLA.

---

## MemGraphRAG — Three-Layer Memory Validation

MemGraphRAG (Xiamen + Jilin University, 2026) introduces a three-layer memory architecture with three specialized agents. Outperforms all existing RAG systems including Microsoft GraphRAG, LightRAG, and HippoRAG. The architecture validates the Tribunus Codex design structurally.

### Architecture Mapping

| MemGraphRAG | Tribunus Codex |
|-------------|---------------|
| Ontology layer (schema-level type relations, structural constraints) | Design tokens + component schema (W3C DTCG, what kinds of components exist) |
| Factual layer (instantiated entity-relation triples for reasoning) | Diagnostic packets (concrete confirmed solutions) |
| Passage layer (source text preserved for evidence grounding) | Evidence ring (commits, PRs, test results, provenance) |
| Extraction agent | Cartographer (maps current surface) |
| Conflict detector agent | Critic council member (detects contradictions between diagnostic approaches) |
| Conflict handler agent | Architect/resolver (consults original evidence, resolves contradictions) |

### Structural Validations

**Bidirectional Linking Contract.** "Every fact must be governed by a validity rule in the ontology layer, and every fact is tethered to the exact passage where it was found." This is the Codex provenance contract: every diagnostic packet must reference valid design tokens AND link to the commit/PR evidence.

**Specialized Agents, Not Generalists.** "Don't give them two jobs, only one job." Three agents (extract, detect conflict, resolve conflict) outperform one generalist. This validates the critic council model: seven specialized critics, each with one evaluation dimension.

**Cheap Models, Stable Architecture.** Entire paper run on GPT-4 Omni Mini (not top-tier). "The methodology works even with non-top-notch models." The value is in the three-layer memory structure and multi-agent governance, not raw model capability. This validates the Tribunus thesis: coordination fabric and evidence ring provide the value; models are infrastructure.

**Novelty Pressure.** When multiple facts conflict, the conflict handler consults the passage layer (original source text) to determine which is correct. This is the superseded knowledge model: the codex preserves all approaches; when diagnostic packets conflict, the evidence ring determines which is valid. No approach is deleted. The lineage is preserved.

**Graph Bridging Prevents Islands.** Type-based bridging (shared high-level category) and similarity-based bridging (cosine similarity between embeddings) prevent fragmented knowledge graphs. This maps to Codex namespace routing (type-based) and pgvector symptom signature matching (similarity-based).

**PageRank for Retrieval.** Suppresses generic hub nodes. Prioritizes rare, high-information-density passages. This is the dharma-weighted queue priority model: suppress obvious first-answer matches, prioritize novel approaches confirmed by multiple downstream PRs.

**Offline-Intensive, Online-Fast.** Heavy preprocessing during graph construction enables lightweight, fast retrieval at query time. This maps to Tribunus' desktop model: heavy agent work during sessions, millisecond codex queries via pgvector HNSW + pg_textsearch BM25.

### Direct Codex Enhancements from MemGraphRAG

1. **Ontology layer as explicit schema.** The design token system should include a formal ontology: which token types exist, which component categories, which valid relationships between them. This is a natural extension of W3C DTCG.

2. **Conflict detection as a first-class critic.** Add a "Consistency" critic to the design council. It checks whether the proposed mutation conflicts with any existing diagnostic packet's approach. Conflict is not rejection — it triggers the evidence-backed resolution process.

3. **Passage-layer linking.** Every diagnostic packet should store explicit evidence references as hash-linked passages (commit hashes, test result hashes, PR hashes) that ground each claim in the packet to its original source.

4. **Graph bridging for the codex.** When two diagnostic packets solve related problems but aren't formally linked, type-based bridging (shared bug category) and similarity-based bridging (pgvector cosine similarity) connect them. This prevents the codex from becoming isolated islands of knowledge.

---

## Synthesis

Rig Relay provides the **governance infrastructure**: schema-first architecture, content-light boundaries, append-only event sourcing, canonical evidence authority, path-lease coordination, tamper-evident audit trails, and lane closure discipline. These are the engineering patterns that make Tribunus trustworthy.

MemGraphRAG provides the **knowledge architecture validation**: three-layer memory (ontology/factual/passage), specialized multi-agent governance, conflict detection and resolution, bidirectional linking between schema/instance/evidence, and graph bridging to prevent fragmentation. These validate that the Codex/dharma/diagnostic-packet architecture is not just a product idea — it is the correct architecture for knowledge management in multi-agent systems, and it outperforms every alternative.

Together they confirm that Tribunus' architecture is sound, novel where it matters (Codex with superseded knowledge, evidence routing, dharma economy), and implementable with known patterns (schema-first, event-sourced, content-light, lease-coordinated).
