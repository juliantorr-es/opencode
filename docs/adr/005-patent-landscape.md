# Tribunus — Patent Landscape & Filing Strategy

## Strongest Claims — Likely Novel

### 1. Superseded Knowledge Codex with Novelty Pressure

A knowledge repository that preserves the full solution lineage (workaround → root cause → edge case → architectural reframing) and enforces novelty pressure — new contributions must be different from everything already in the existing packet. No patent found on this approach. Stack Overflow collapses to "accepted answer." The Codex preserves the full diagnostic tree and requires novel contributions, not faster ones. This inverts the operating model of every existing developer Q&A system.

### 2. Diagnostic Packet Routing by Engineering Evidence

Matching bugs by symptom signature, environment shape, file involvement patterns, and failed-hypothesis trees — not text similarity. Existing systems (Airbot, Leroy Merlin PR Analyzer) automate diagnostics within a single organization. `reposit` (GitHub, Feb 2026) is knowledge-sharing for AI agents with search/share/vote but operates on text, not structured engineering evidence. No system routes diagnostic packets between peer developers using structured evidence for matching.

### 3. Consent-Gated Diagnostic Packet → PR Loop

Automated PR generation exists (US11030071B2), Airbot generates PRs from diagnostics, agentic LLMs generate fixes from natural language. But none implement the full chain where: a human approves disclosure, the diagnostic packet transfers with provenance, the receiving agent adapts locally (not blind-copies), and the resulting PR carries the diagnostic lineage as its description. The human-consent gate at every stage is the differentiator. Existing systems are either fully automated or single-developer, not peer-to-peer with consent.

### 4. Functional Dharma Economy with Queue Priority

Reputation-based systems exist (Stack Overflow badges, trust-based task assignment patent 2009, utility-based reputation in P2P networks). None combine: GitHub-identity-bootstrapped reputation, confirmed-downstream-utility-weighted scoring, queue-priority-based rewards (system privilege, not badges), and recency decay. The reward is functional priority in the support queue and codex sync frequency — not gamified status.

## Moderate Strength — Combination Claims

### 5. Three-Database Architecture with Clean Contracts

PGlite for durable intelligence, Valkey for live coordination, DuckDB for retrospective learning. Each individual component has prior art, but the combination with explicit boundary contracts preventing category errors appears novel. ContextLattice (2026) is a local-first control plane but does not implement this three-way separation with explicit authority boundaries and rebuild-from-PGlite recovery protocols.

### 6. Conductor Model — Serializing Coordination Without Serializing Execution

Using a single-threaded coordinator to serialize authority-changing events while workers execute in parallel. The pattern exists in databases and distributed systems, but applying it as a first-class architectural pattern for agent orchestration with explicit primitives (Streams for work queues, Sorted Sets as timing wheels, TTL keys for heartbeats/leases, pub/sub for volatile UI only) with a defined authority boundary and PGlite rebuild protocol may be novel as applied to multi-agent software development.

## Prior Art — Not Patentable in Isolation

- Vector similarity for bug matching (pgvector is standard infrastructure)
- JSONB for structured packet storage (standard Postgres feature)
- Consumer groups for agent work queues (Valkey/Redis Streams are standard)
- Live queries for reactive UI (PGlite standard feature)
- Automated PR generation from diagnostics (US11030071B2, Airbot)
- Trust-based task assignment (2009 patent)

## Recommended Filing Strategy

1. **File a provisional patent now** — locks in June 2026 priority date. Covers claims 1–4. Gives 12 months to file the non-provisional.
2. **File 2 utility patents from the provisional:**
   - **Patent A**: Superseded Knowledge Codex + Evidence-Based Packet Routing
   - **Patent B**: Consent-Gated Diagnostic Packet → PR Loop + Functional Dharma Economy
3. **Monitor** Airbot, ContextLattice, and reposit for overlapping claims before filing non-provisional.

## Competitive Moat Beyond Patents

The codex/dharma/diagnostic-packet loop is difficult to replicate because it requires: the coordination fabric, agent state machines, evidence ring, GitHub identity integration, privacy/redaction gate, PGlite/Valkey/DuckDB architecture, and community network effects. Patents protect the structural innovations. Network effects protect the rest.
