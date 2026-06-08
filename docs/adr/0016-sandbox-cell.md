# ADR 016: Repository Sandbox Serving — Browser Sandbox Cell

## Status
Accepted — June 2026

## Context

ADR 014 defined the Tribunus Cell as a sovereign local authority domain. This ADR extends the model to multi-user collaboration through a browser sandbox Cell. The owning Cell must never let other Cells mutate the original project workspace directly. Instead, it publishes a controlled working copy into a browser-executable sandbox, lets collaborators operate inside that copy, and receives back a reviewable change envelope. The owning Cell remains the authority that decides whether those changes become part of the real local project.

## Decision

### Three Planes

**Plane 1 — Served Repository Snapshot.** The owner Cell exports a copy of the repository into a sandbox-compatible form. For browser mode, this means a virtual filesystem snapshot, not direct access to the native filesystem. The snapshot includes source identity: cell ID, project scope key, repo root identity, base git commit if available, content hash, export time, and export policy. This is the sandbox's equivalent of "where did this workspace come from?"

**Plane 2 — Collaborative Sandbox Runtime.** Browser sandbox where WebContainer, browser filesystem, shared editor state, terminal emulation, artifact preview, and agent execution live. Fast-paced changes happen here because the blast radius is limited. It has its own sessions, artifacts, command receipts, and lifecycle states. Every receipt carries the origin snapshot identity so it can later be reconciled with the owning Cell.

**Plane 3 — Import and Merge Gate.** The owning Cell receives a change envelope from the sandbox. Not just a diff — the envelope includes: base snapshot identity, changed files, deleted files, generated artifacts, command/test receipts, author/collaborator attribution, agent receipts, and any conflicts detected against the owner's current project state. The owner Cell validates locally before writing into the actual project.

### Authority Model

> Owner Cell publishes; sandbox Cell executes; participant Cells collaborate; owner Cell reviews and merges.

No sandbox change is authoritative until the owning Cell imports it. The browser sandbox is a mounted snapshot with provenance, not a direct replica of the repo. The owning Cell says: "Here is project X at commit/hash/snapshot Y, with this allowlist of paths, this package-manager profile, this execution capability profile, and this merge policy." Changes accrue inside the sandbox as a patch lineage against that origin — not as authoritative repo history.

### Canonical Records

**ServedRepositorySnapshot**
- Source cell ID, project scope key
- Base commit or content hash
- Exported paths and allowlist
- Capability policy (allowed agents, allowed commands, max runtime)
- Export time and expiration
- Merge policy (auto-merge if clean, review always, review required for specific paths)

**SandboxWorkspaceLifecycle**
- States: origin_snapshot_loading → sandbox_ready → collaboration_active → proposal_building → proposal_submitted → origin_out_of_date → sandbox_archived
- Tracks whether the sandbox is loading, ready, collaborating, executing, degraded, or proposal-ready
- Links to origin snapshot identity

**SandboxChangeProposal**
- Base snapshot identity (what was this built against)
- Changed files, deleted files, renamed files
- Generated artifacts with receipts
- Command/test receipts
- Author and collaborator attribution (GitHub identities)
- Agent receipts (if agents were used)
- Validation summary against owner's current state
- Import status: base_current, base_stale_but_cleanly_applies, base_stale_with_conflicts, origin_missing

### Owner Cell State Machine

| State | Meaning |
|-------|---------|
| `sandbox_serving` | Snapshot exported and being served to browser sandbox |
| `sandbox_active` | Sandbox is live, collaborators are working |
| `sandbox_proposal_received` | Change proposal has been submitted from sandbox |
| `sandbox_import_validating` | Proposal is being validated against current project state |
| `sandbox_import_ready` | Proposal validated, ready for operator review |
| `sandbox_import_blocked` | Conflicts or policy violations prevent import |
| `sandbox_import_applied` | Changes merged into the authoritative project |

### Base Invariant

If the owner project has moved since the sandbox was exported, the owner Cell must not blindly apply the patch. It must classify: `base_current`, `base_stale_but_cleanly_applies`, `base_stale_with_conflicts`, or `origin_missing`. This classification belongs in lifecycle/projection, not hidden in an error log.

### Cell Authority Semantics

A Cell is not "one physical device." A Cell is an authority domain. The owner desktop Cell is the authority over the real repo. The browser sandbox Cell is the authority over a derived workspace. A future team Cell could be the authority over a shared project namespace. Federation is envelope exchange between authority domains — not row sync, not shared mutable state.

### Product Shape

1. Local Tribunus desktop Cell serves a browser-safe copy of the project ("Share sandbox")
2. Collaborators open it in the browser, work together, run WebContainer-compatible commands, inspect previews, generate a proposed patch
3. Desktop owner sees: "Sandbox proposal ready: 11 files changed, 3 tests passed, 1 artifact generated, base commit still current"
4. Owner reviews and decides: import, request revision, or reject

### Internal Contract

The sandbox should be treated as a branch-like workspace, but not necessarily a Git branch at first. Internally, the contract is "snapshot plus patch bundle." Later this can map to actual Git branches, PRs, patches, or review packets. Starting with Git-first semantics overconstrains the architecture because browser sandboxes, generated artifacts, virtual filesystems, and agent receipts are broader than Git alone.

## Relationship to Existing ADRs

- ADR 014: Tribunus Cell model — this ADR composes Cells across the source/sandbox boundary
- ADR 004: Valkey coordination kernel — sandbox state machine maps to Valkey Streams and Sorted Sets
- ADR 003: PGlite as durable truth — owner Cell PGlite is authoritative; sandbox Cell PGlite is disposable
- ADR 006: PWA as remote cockpit — browser sandbox is the next collaborative surface beyond the cockpit
- ADR 013: OSS Integrity Gate — applies to sandbox change proposals: no license laundering through sandbox contributions

## Consequences

### Positive
- **Browser mode is useful without pretending it has desktop authority.** Fast, shareable, disposable execution and collaboration. Desktop remains the authoritative merge surface.
- **Clear authority boundary.** No sandbox change is authoritative until the owning Cell imports it. The blast radius is contained.
- **Federation model extends cleanly.** A Cell is an authority domain. The pattern scales from solo (one Cell) to sandbox collaboration (two Cells) to team (N Cells exchanging envelopes).
- **Receipt-backed review.** The owner doesn't review raw changes. They review a change proposal with provenance, receipts, and classification.

### Negative
- **More ceremony than direct remote editing.** The snapshot → import cycle adds latency compared to real-time shared editing. Acceptable for governed collaboration; use Automerge/Yjs for real-time co-editing of documents as per ADR 014.
- **WebContainer dependency.** Browser sandbox execution requires WebContainer or equivalent browser filesystem + runtime. WebContainer is a product decision, not an architectural one — the sandbox contract is protocol-level, independent of the runtime.
- **Snapshot size.** Exporting a full project snapshot for every sandbox session is wasteful for large repos. Mitigated by incremental exports (only changed files since last snapshot) and path allowlists.

## References
- ADR 003: PGlite + Valkey + DuckDB Data Architecture
- ADR 004: Valkey as Coordination Kernel
- ADR 006: Mobile PWA as Remote Cockpit
- ADR 013: OSS Integrity Gate
- ADR 014: Tribunus Cell — Sovereign Local Federation
- WebContainers: https://webcontainers.dev
