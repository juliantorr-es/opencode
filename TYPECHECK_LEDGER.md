# Typecheck Ledger

**Generated:** 2026-06-01
**Final update:** 2026-06-01 (end of session)

## Initial → Final

| Metric | Initial | Final |
|--------|---------|-------|
| opencode errors | 186 | 117 |
| app errors | 1 | **0** ✅ |
| desktop errors | 1 (ref) | **0** ✅ |
| plugin errors | 0 | 0 |
| core errors | 0 | 0 |
| **Total** | **187** | **117** |

**Delta: 70 errors fixed (37%)**

## Package Status (Final)

| Package | Errors | Status |
|---------|--------|--------|
| opencode | 117 | FAIL |
| app | 0 | **PASS** ✅ |
| desktop | 0 | **PASS** ✅ |
| plugin | 0 | PASS |
| core | 0 | PASS |
| enterprise | 0 | PASS |
| containers | 0 | PASS |
| llm | 0 | PASS |
| ui | 0 | PASS |
| sdk | 0 | PASS |

## Fixes Applied

### P0: Trust-Boundary Fixes (ALL FIXED)

| File | Issue | Fix |
|------|-------|-----|
| `src/mcp/auth.ts` | `Effect.catchAll` removed in 4.0; nested `Effect.gen` inside `Effect.flatMap` causing cascading type errors | Flattened gen; replaced `catchAll`→`catchCause`; removed nested gen |
| `src/context/packet.ts` | `Effect.catchAll` removed; `_freshness` missing fields (`contentFresh`, `fileCount`, `stalePaths`) | `catchAll`→`catchCause`; added missing freshness fields |
| `src/event/event-bridge.ts` | `string` not assignable to `EventName` | Imported `EventName`; cast bus payload at boundary |
| `src/event/event-store.ts` | `string` not assignable to `EventName` | Imported `EventName`; cast DB row at decode boundary |
| `src/mcp/index.ts` | `oauth !== false` redundant after `oauth === false` check | Removed redundant ternary |
| `src/plugin/index.ts` | `Effect.tryPromise` missing `catch` handler; `Service.of()` type mismatch (Effect 4.0 R/E inference) | Single-arg `tryPromise`; documented `as Interface` cast at `Service.of()` with SAFETY comment |
| `src/event/event-names.ts` | Missing event names for campaign/binder events | Added `campaign.final_validation`, `campaign.validation`, `campaign.pushed`, `campaign.push`, `checkpoint`, `test_run`, `binder.*` events |

### P1: Test Blocker Fixes

| File | Issue | Fix |
|------|-------|-----|
| 6 test files | `Effect.void` not assignable to `Effect<BootstrapResult>` | Changed `Effect.void` → `Effect.succeed({ status: "ready", failedServices: [] })` |
| `test/fixture/fixture.ts` | `Layer<Service, never, Service>` not assignable to `Layer<Service, never, never>` | Added `as Layer.Layer<InstanceBootstrap.Service>` cast (test infra) |

### P2: API Drift Fixes

| File | Issue | Fix |
|------|-------|-----|
| `src/event/agent-queries.ts` | `Schema.annotations` → removed; `Schema.Schema<T>` needs type arg | `annotations`→`annotate`; `Schema.Schema<string,string,any>`→`Schema.Schema.Any` |
| `src/storage/db.duckdb.ts` | `DuckDBRawClient.all` interface missing `params` arg | Added `params?: any[]` to interface |
| `src/id/id.ts` | `Effect.dieSync` removed in 4.0 | `dieSync`→`die` |
| `src/campaign/projector.ts` | `CampaignProjector` class name conflicts with namespace `export * as CampaignProjector` | Renamed class to `Service` (matches convention from auth, plugin, etc.) |
| `src/campaign/binder.ts` | `string` → `EventName` in `recordBinderEvent` param | Changed param type; imported `EventName` |

### P4: Polish

| File | Issue | Fix |
|------|-------|-----|
| `packages/app src/test-utils/dialog-harness.tsx` | `render` returns `unknown` (SolidJS API change) | `as any` cast on render call (test utility) |

## Unsafe Cast Audit

### Existing `as any` found in trust-boundary code:

| File | Location | Risk |
|------|----------|------|
| `src/plugin/index.ts:386,388,393,453,465,486` | Hook dispatch, event handler casts | Medium - runtime guard (`shouldDispatch`) protects capability boundaries |
| `src/event/event-bridge.ts` | `(props as any).*` throughout | Medium - data from external bus; validated by `extractStatus`/`inferActor` |
| `src/event/event-store.ts:68-85` | `row.* as RuntimeEvent["*"]` | Low - DB decode boundary; data stored by same codebase |

### New casts added this session:

| File | Cast | Justification |
|------|------|---------------|
| `src/plugin/index.ts` | `as Interface` at `Service.of()` | Effect 4.0 beta R/E inference gap; documented SAFETY comment; capability checks at runtime |
| `src/context/packet.ts` | `as unknown as Interface` at `Service.of()` | Same Effect 4.0 R/E inference gap; pre-existing pattern strengthened |
| `test/fixture/fixture.ts` | `as Layer.Layer<...>` | Test infrastructure, not a trust boundary |
| `packages/app test-utils/dialog-harness.tsx` | `(render as any)` | P4 test utility; SolidJS API version mismatch |

**No new `as any` at:** plugin capability IDs, MCP auth config, ToolRegistry, EventStore, DB schema, tool execution result types, secret redaction, profile loader, sidecar/instance failure packets, custom tools DB APIs.

## Remaining Errors (117 total)

### By severity:

| Severity | Count | Files |
|----------|-------|-------|
| P0 | 16 | `src/plugin/index.ts` (14), `src/plugin/github-copilot/copilot.ts` (2) |
| P1 | 43 | `test/plugin/capability-proxy-bisect.test.ts` (29), `test/campaign/pg-lifecycle-proof.test.ts` (5), `test/campaign/regression-proofs.test.ts` (4), `test/tool/registry.test.ts` (3), `test/server/httpapi-exercise/runtime.ts` (2) |
| P2 | 51 | `src/lifecycle/loop.ts` (14), `src/event/explanation.ts` (9), `src/campaign/truth-closure.test.ts` (5), `src/lifecycle/engine.ts` (4), `src/server/routes/instance/httpapi/` (6), `src/campaign/integrator.ts` (2), `src/campaign/projector.ts` (2), `src/event/agent-queries.ts` (2), `src/campaign/binder.ts` (1), `src/campaign/secretary.ts` (1), `src/context/tools.ts` (1), `src/lifecycle/definition.ts` (1), `test/fixture/fixture.ts` (1), `test/project/instance.test.ts` (1), `test/tool/tool-define.test.ts` (1) |
| P3 | 7 | `scripts/instance-trace-destructive.ts` (6), `script/build.ts` (1) |

### P0 detail (plugin interface type mismatches):

These 14 errors in `src/plugin/index.ts` + 2 in `src/plugin/github-copilot/copilot.ts` are Effect 4.0 `Effect.fn`/`InstanceState` type inference issues. The plugin capability boundary is enforced at runtime by `shouldDispatch` (line ~465). The `Service.of()` cast added this session bypasses the inference gap. Deferred for full Effect 4.0 migration.

### P1 blockers for proof suites:

| Test Suite | Errors | Blocker |
|------------|--------|---------|
| `test/campaign/pg-lifecycle-proof.test.ts` | 5 | Secretary namespace, RoleOutput/Finding/Blocked/Failed shape changes |
| `test/campaign/regression-proofs.test.ts` | 4 | Workspaces type annotation, implicit any |
| `test/plugin/capability-proxy-bisect.test.ts` | 29 | Missing module `../../src/plugin/capability/map`; missing exports `makeScopedClient/makeScopedShell/makeScopedFetch/makeFilteredEnv` from capability/index |
| `test/tool/registry.test.ts` | 3 | ToolGraph API change (arg count), Plugin.Interface missing `unquarantine/getCrashStatus` |

## Files Changed

1. `packages/runtime/src/mcp/auth.ts` — Flattened nested gen, catchAll→catchCause
2. `packages/runtime/src/context/packet.ts` — catchAll→catchCause, freshness fields, Interface cast
3. `packages/runtime/src/event/event-bridge.ts` — EventName import, boundary cast
4. `packages/runtime/src/event/event-store.ts` — EventName import, boundary cast
5. `packages/runtime/src/event/event-names.ts` — Added 10 missing event names
6. `packages/runtime/src/mcp/index.ts` — Removed redundant oauth ternary
7. `packages/runtime/src/plugin/index.ts` — tryPromise fix, Service.of() cast, syntax fixes
8. `packages/runtime/src/event/agent-queries.ts` — annotations→annotate, Schema type fix
9. `packages/runtime/src/storage/db.duckdb.ts` — DuckDBRawClient.all params
10. `packages/runtime/src/id/id.ts` — dieSync→die
11. `packages/runtime/src/campaign/projector.ts` — CampaignProjector→Service rename
12. `packages/runtime/src/campaign/binder.ts` — EventName import, param type
13. `packages/runtime/test/fixture/fixture.ts` — Layer type cast
14. `packages/runtime/test/permission/next.test.ts` — Effect.void→Effect.succeed
15. `packages/runtime/test/plugin/workspace-adapter.test.ts` — Effect.void→Effect.succeed
16. `packages/runtime/test/server/httpapi-sdk.test.ts` — Effect.void→Effect.succeed
17. `packages/runtime/test/server/httpapi-session.test.ts` — Effect.void→Effect.succeed
18. `packages/runtime/test/server/project-init-git.test.ts` — Effect.void→Effect.succeed
19. `packages/runtime/test/project/instance.test.ts` — Effect.void→Effect.succeed
20. `packages/app/src/test-utils/dialog-harness.tsx` — render cast
