# Tribunus Bootstrap Control Plane v1 Hardening Gate — Completion Report

**Status**: Bootstrap-ready and false-success-resistant. Not production-ready.
**Date**: 2026-06-06
**Tests**: 57 pass, 0 fail across 2 test files (7 domains)

## Gate Summary

The hardening gate proves that the bootstrap control plane primitives cannot lie. Invalid inputs, broken dependencies, stale leases, orphaned records, duplicated initialization, and incomplete checkpoint lineage all produce explicit failures with typed receipts rather than silent success, empty context, duplicate rows, or corrupted state.

## Changed Files

### Production code (2 files)

- `packages/opencode/src/tribunus/control-plane/checkpoint.ts` — Rewritten. Memory recall now uses the strict `executeMnemopi` helper from `tribunus_memory.ts` instead of raw `Bun.spawn`. Failures are hard failures (`memoryContextStatus: "failed"`) not silent empty results. Git state unavailability is explicitly reported (`available: false`) instead of swallowed. Checkpoint receipt verdict reflects actual operational quality (`pass` / `warning` / `fail`).

- `packages/opencode/src/tribunus/control-plane/crud.ts` — Three fixes:
  1. `tribunusCheckpointCreate`: fixed INSERT having 22 `?` placeholders for 21 columns (pre-existing bug, never hit because no tests existed).
  2. `tribunusReceiptCreate`: returns the actual stored receipt with correct `actor`, `source`, `verdict`, and `error` fields instead of a synthetic `generateReceipt` output that always had `actor: "system"`.
  3. Added `tribunusTaskTransition`: validates transitions against a state machine (`pending → in_progress → blocked → in_progress → completed`). Fast-complete (`pending → completed`) requires `fastComplete: true` and evidence. `blocked → completed` is not a valid transition. Terminal states reject further transitions. Every transition emits a receipt with `previousState` and `nextState`.

### Test files (2 files, 57 tests)

- `packages/opencode/src/tribunus/control-plane/hardening.test.ts` — 46 adversarial tests across 7 domains:
  - Domain 1 (Relational Integrity): FK enforcement, parent existence validation, duplicate slug prevention, orphan prevention (campaign, mission, lane, task, checkpoint, receipt, memory_link).
  - Domain 2 (Init Idempotency): duplicate slug rejection, row count verification.
  - Domain 3 (Lane Leases): conflict detection (overlap, disjoint, read-only, empty paths), claim/release lifecycle, expired lease reclaim, force-claim warning verdict.
  - Domain 4 (Task Transitions): valid transitions, terminal state rejection, blocked→completed rejection, fast-complete gate, receipt emission.
  - Domain 5 (Checkpoint Lineage): task/lane/mission validation, lineage mismatch detection, project/campaign capture.
  - Domain 6 (Receipt Completeness): pass/fail/warning verdicts, actor/source propagation, error field presence.
  - Domain 7 (Memory Link Integrity): entity existence validation, duplicate prevention, table suffix resolution.

- `packages/opencode/src/tribunus/control-plane/mnemopi-hardening.test.ts` — 11 adversarial tests across 3 domains:
  - Mnemopi Execution: invalid bank rejection, missing directory rejection, empty success vs failure distinction, receipt field completeness.
  - Bank Isolation: invalid bank rejection, cross-bank sentinel isolation, receipt metadata completeness, bank list verification.
  - Memory Receipt Completeness: recall/remember receipt field presence, error field on failure.

## Acceptance Criteria — All Passing

| Criterion | Status |
|---|---|
| Invalid bank names fail closed | PASS |
| Missing physical paths fail closed | PASS |
| Non-zero Mnemopi exits fail closed | PASS |
| Malformed recall output fails closed | PASS |
| Isolation checks prove no cross-bank leakage | PASS |
| Duplicate initialization does not duplicate seed rows | PASS |
| Foreign keys are active and prevent orphaned children | PASS |
| Overlapping write lanes detected as conflict | PASS |
| Non-expired lease cannot be stolen without force | PASS |
| Expired leases reclaimable with receipts | PASS |
| Checkpoints require valid lineage | PASS |
| Resume packets include operational state and memory context status | PASS |
| Task transitions produce receipts | PASS |
| Invalid transitions are rejected | PASS |
| Memory links cannot orphan silently | PASS |

## Remaining Seams

These are explicitly out of scope for this gate and belong to future hardening or the full Tribunus runtime:

1. **SQLite-to-PGlite migration** — The schema is SQLite. Production uses PGlite via Drizzle. Migration requires porting the SQL DDL to `.pg.sql.ts` files.
2. **Cockpit UI projection** — The control plane has no visualization. Entity relationships, lease status, and checkpoint lineage need a cockpit.
3. **Full session-close consolidation** — Checkpoint→resume packet integration with the session lifecycle is not yet automated.
4. **Native Tribunus MemoryRuntime absorption** — `checkpoint.ts` embeds a copy of `executeMnemopi`. The MemoryRuntime should be a shared service.
5. **Extension memory isolation** — Memory bank isolation between extensions is specified but not yet implemented.
6. **Dharma-based agent trust** — Trust/reputation integration for lease claimants and task assignees.
7. **Graph triple support** — Memory links are flat. A knowledge graph layer would enable transitive relationships.
8. **Path-glob engine** — The lane conflict checker uses conservative prefix matching. A proper glob engine would handle `**` wildcards correctly.
9. **Distributed lease system** — Leases are local SQLite. For multi-process Tribunus, leases need Valkey-backed coordination.

## Verification Commands

```bash
# Control plane test suite (all domains)
cd packages/opencode && bun test src/tribunus/control-plane/hardening.test.ts

# Memory isolation tests
cd packages/opencode && bun test src/tribunus/control-plane/mnemopi-hardening.test.ts

# Both suites
cd packages/opencode && bun test src/tribunus/control-plane/hardening.test.ts src/tribunus/control-plane/mnemopi-hardening.test.ts

# Init idempotency (manual)
cd packages/opencode && bun run src/tribunus/control-plane/init.ts
cd packages/opencode && bun run src/tribunus/control-plane/init.ts  # second run, verify no duplicates
```

## Doctrine Compliance

The gate satisfies the Tribunus hardening doctrine: no authority claim without observable backing. A logical bank resolves to a physical Mnemopi data directory. A lane claim resolves to a non-overlapping write scope. A checkpoint resolves to a valid mission, lane, task, git state, memory context, and next-safe-action. A task transition resolves to a receipt. A memory link resolves to an actual control-plane entity and a scoped Mnemopi memory. Initialization is idempotent. Recovery is explicit. Nothing succeeds just because the happy path worked once.
