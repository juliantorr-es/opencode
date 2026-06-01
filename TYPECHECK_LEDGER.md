# Typecheck Ledger

**Generated:** 2026-06-01
**Command:** `bun turbo typecheck` (individual packages)
**Initial error count:** 187 (186 opencode + 1 app/desktop)

## Package Status

| Package | Errors | Status |
|---------|--------|--------|
| opencode | 186 | FAIL |
| app | 1 | FAIL |
| desktop | 1 (ref) | FAIL |
| plugin | 0 | PASS |
| core | 0 | PASS |
| enterprise | 0 | PASS |
| containers | 0 | PASS |
| llm | 0 | PASS |
| ui | 0 | PASS |
| sdk | 0 | PASS |

## Severity Classification

### P0: Trust-Boundary / Runtime Authority (36 errors)

Files that decide permissions, secrets, tools, events, persistence, or process startup.

| # | File | Line | Code | Message | Fix |
|---|------|------|------|---------|-----|
| 1 | src/mcp/auth.ts | 88 | TS2488 | `never` iterator | catchTag → gen |
| 2 | src/mcp/auth.ts | 94 | TS2339 | `catchAll` not on Effect | catchCause |
| 3 | src/mcp/auth.ts | 94 | TS7006 | implicit `any` error param | type annotation |
| 4-16 | src/mcp/auth.ts | 168-180 | TS2322/TS2719 | `unknown` vs `never` in MCP auth service | fix interface R type |
| 17 | src/plugin/index.ts | 69 | TS2345 | missing `catch` in abort handler | add catch |
| 18 | src/plugin/index.ts | 204 | TS7022 | `state` implicit any | type annotation |
| 19 | src/plugin/index.ts | 205 | TS2345 | `unknown` vs `Scope` in service init | fix R type |
| 20 | src/plugin/index.ts | 205 | TS7024 | function implicit any return | type annotation |
| 21 | src/plugin/index.ts | 382-383 | TS7024 | function implicit any return | type annotations |
| 22 | src/plugin/index.ts | 385,508,513 | TS18046 | `s` is of type unknown | narrow or cast with validation |
| 23-24 | src/plugin/index.ts | 409,429 | TS2322 | `unknown` vs `never` | fix R type |
| 25-28 | src/plugin/index.ts | 543 | TS2322 | `unknown` vs `never` in service interface | fix R type |
| 29-30 | src/plugin/github-copilot/copilot.ts | 107,140 | TS2345 | filter callback types | type annotations |
| 31 | src/event/event-bridge.ts | 61 | TS2322 | string → EventName | use EventName type |
| 32 | src/event/event-store.ts | 73 | TS2322 | string → EventName | use EventName type |
| 33 | src/mcp/index.ts | 923 | TS2367 | oauth config vs boolean comparison | fix conditional |

### P1: Proof-Suite Blockers (51 errors)

Errors that prevent important tests from running.

| # | File | Line | Code | Message | Blocks |
|---|------|------|------|---------|--------|
| 34-39 | test/campaign/pg-lifecycle-proof.test.ts | 35-596 | TS2503/TS2345/TS2353/TS2322 | Secretary namespace, RoleOutput, Blocked/Failed shapes | campaign PG proof |
| 40-43 | test/campaign/regression-proofs.test.ts | 804-809 | TS2502/TS7006 | workspaces type annotation, implicit any | campaign regression |
| 44-72 | test/plugin/capability-proxy-bisect.test.ts | 56-473 | TS2307/TS2339 | missing module, missing exports | plugin capability tests |
| 73-75 | test/tool/registry.test.ts | 72-81 | TS2554/TS2339/TS2739 | ToolGraph API, Registry interface | tool registry tests |
| 76 | test/tool/tool-define.test.ts | 146 | TS2352 | invalid cast | tool define tests |
| 77 | test/fixture/fixture.ts | 21 | TS2345 | Layer type parameter | ALL tests using fixture |
| 78 | test/permission/next.test.ts | 15 | TS2322 | BootstrapResult void | permission tests |
| 79 | test/plugin/workspace-adapter.test.ts | 44 | TS2322 | BootstrapResult void | plugin tests |
| 80 | test/project/instance.test.ts | 14 | TS2322 | BootstrapResult void | project tests |
| 81-82 | test/server/httpapi-exercise/runtime.ts | 11,30 | TS2307 | missing tui-control module | httpapi exercise |
| 83 | test/server/httpapi-sdk.test.ts | 28 | TS2322 | BootstrapResult void | httpapi sdk tests |
| 84 | test/server/httpapi-session.test.ts | 45 | TS2322 | BootstrapResult void | httpapi session tests |
| 85 | test/server/project-init-git.test.ts | 23 | TS2322 | BootstrapResult void | project init tests |

### P2: Stale API Drift (93 errors)

Old names, moved exports, outdated fixtures, renamed events.

| Subsystem | Files | Count | Root Cause |
|-----------|-------|-------|------------|
| Agent Queries (tools) | src/event/agent-queries.ts | 18 | Schema.Struct annotations, Tool.Init API, EventName |
| Lifecycle Engine | src/lifecycle/loop.ts, engine.ts, definition.ts | 19 | Effect API (Gen vs Effect, Finish), Record params |
| Event Explanation | src/event/explanation.ts | 9 | Effect args, QueryFilters, null vs undefined |
| Campaign Truth Closure | src/campaign/truth-closure.test.ts | 20 | EventName, RuntimeEvent shapes, status enum |
| Campaign Projector | src/campaign/projector.ts | 5 | Redeclared export, DatabaseError vs never |
| Campaign Auditor/Binder/Integrator | src/campaign/auditor.ts, binder.ts, integrator.ts | 8 | EventName, Layer type |
| Context | src/context/packet.ts, duckdb-rank.ts, tools.ts | 5 | catchAll, Freshness shape, Effect args |
| ID | src/id/id.ts | 1 | dieSync removed from Effect |
| HTTP API Claims | src/server/routes/instance/httpapi/ | 6 | Drizzle column types, PathTreeNode, Effect args |

### P3: Legacy/Dead Surfaces (7 errors)

| # | File | Count | Issue |
|---|------|-------|-------|
| | script/build.ts | 1 | @opentui/core not in dependency map |
| | scripts/instance-trace-destructive.ts | 6 | Interface missing Service props, writePhase/writeFailure |

### P4: Polish (1 error)

| # | File | Line | Code | Issue |
|---|------|------|------|-------|
| | packages/app src/test-utils/dialog-harness.tsx | 54 | TS2322 | unknown → Element |

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| P0 | 36 | Trust-boundary / runtime authority |
| P1 | 51 | Proof-suite blockers |
| P2 | 93 | Stale API drift |
| P3 | 7 | Legacy/dead surfaces |
| P4 | 1 | Polish |
| **Total** | **187** | (186 opencode + 1 app/desktop) |
