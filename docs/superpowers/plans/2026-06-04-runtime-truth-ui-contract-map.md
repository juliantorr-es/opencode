# Runtime Truth UI Contract Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every UI surface that implies runtime truth obey the same recovery contract, starting with the highest-risk visible surfaces and making coordination failure impossible to hide behind generic "ready" copy.

**Architecture:** Treat runtime truth as a shared contract, not a per-component interpretation. The contract starts in the instance HTTP and session status APIs, flows through the embedded session shell and workspace/admin surfaces, and ends in the actual action controls that can mutate state or continue work. The first pass is a map, not a refactor: classify surfaces by risk, define the exact labels and disabled states each recovery mode can produce, then implement only the first visible vertical slice once the map is agreed.

**Tech Stack:** SolidJS console app, embedded OpenCode UI shell, instance HTTP APIs, Effect-managed session/runtime services, Bun tests.

---

### Contract Map

| Layer | Surface | Current source of truth | Required runtime truth | Allowed labels | Action policy | Risk |
|---|---|---|---|---|---|---|
| Global/runtime chrome | App shell status surface, top-level runtime badge, connection indicator, project selector, workspace/directory badge | `packages/opencode/src/server/shared/ui.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/project.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/workspace.ts` | Coordination health, instance bootstrap health, active project/workspace identity, session status map | `coordination_unavailable`, `coordination_rebuilding`, `coordination_recovered`, `coordination_degraded`, `coordination_refused` | Never show a healthy/ready badge while coordination is unavailable or rebuilding; disable any top-level "ready" affordance during those states | High |
| Session surfaces | Session header, session lifecycle label, transcript banners, retry/resume/stop controls, agent activity indicators | `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`, `packages/opencode/src/session/status.ts`, `packages/opencode/src/session/run-state.ts`, `packages/opencode/src/session/processor.ts` | Session status, session activity, recovery outcome, whether the session can continue safely | Same recovery labels plus any existing idle/busy/retry labels | `rebuilding` means read-only plus recovery messaging; `degraded` allows inspection and recovery but blocks unsafe continuation; `refused` blocks continuation until explicit reauthorization or restart | High |
| Input surfaces | Chat input, send button, prompt submit affordances, stop/retry/resume buttons in the composer area | Session prompt and run-state plumbing, plus the embedded session UI shell served through `packages/opencode/src/server/shared/ui.ts` | Current session status, whether mutation is safe, whether the runtime can accept new work | `idle`, `busy`, and the recovery labels above | Disable send/mutation controls during `coordination_rebuilding`, `coordination_unavailable`, and `coordination_refused`; allow inspection-only actions where safe | High |
| Project/workspace surfaces | Project bootstrap status, workspace list, workspace status, directory/worktree readiness, workspace selector, project metadata | `packages/opencode/src/server/routes/instance/httpapi/groups/project.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/workspace.ts`, `packages/console/app/src/routes/workspace/[id].tsx`, `packages/console/app/src/routes/workspace/common.tsx` | Project identity, workspace connection status, bootstrap readiness, directory/worktree truth | Ready/degraded/failed labels for bootstrap plus the coordination labels when the surface reflects runtime readiness | Do not equate "project exists" with "runtime ready"; do not allow workspace mutations while coordination is rebuilding or refused; treat workspace readiness as medium-high risk whenever it exposes action affordances | Medium-high |
| Tool/capability surfaces | MCP buttons, command palette actions, mutation controls, share/publish actions, artifact actions, shell/terminal entry points | `packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts`, `packages/opencode/src/tool/*`, `packages/opencode/src/command/index.ts`, `packages/opencode/src/share/session.ts`, `packages/opencode/src/share/share-next.ts` | Capability-specific authority, current session recovery state, and whether the action is read-only or mutating | Same recovery labels, but capability-specific status text may also be shown | Read-only actions may stay available during `degraded`; mutating actions must be disabled during `coordination_unavailable`, `coordination_rebuilding`, and `coordination_refused`, and only become available during `degraded` when an explicit safe path marks them safe | High |
| Recovery evidence surfaces | Recovery receipt/history, durable recovery rows, status history viewers, diagnostics entrypoints | `packages/opencode/src/coordination/recovery.ts`, `packages/opencode/src/coordination/recovery.pg.sql.ts` | Durable receipt contents, old/new generation, project/session identity, outcome, reasons, timestamp | `coordination_rebuilding`, `coordination_recovered`, `coordination_degraded`, `coordination_refused` | Must be readable even after teardown/recreate; never collapse the receipt into a transient log-only event | Medium |

### Recovery Policy

| State | What it means | What the UI may say | What the UI must not say | What actions stay enabled | What actions must be disabled |
|---|---|---|---|---|---|
| `coordination_unavailable` | Coordination backend is unreachable or unusable | "Coordination unavailable" | "Ready", "Connected", "Healthy" | Inspection, diagnostics, recovery hints | Any mutation, continuation, or "continue as normal" action |
| `coordination_rebuilding` | The runtime detected a generation reset and is rebuilding safe state | "Rebuilding", "Recovering", "Restoring session state" | "Ready", "Safe to continue" | Read-only inspection, receipt viewing | Send, resume, mutate, publish, tool execution, unsafe continuation |
| `coordination_recovered` | Recovery completed and the runtime re-established safe state | "Recovered", "Ready after recovery" | "Ready" without the recovery context | Normal safe actions | None beyond the normal permission/capability model |
| `coordination_degraded` | Runtime recovered, but some in-flight work or authority is not fully safe | "Recovered with limits", "Degraded", "Partial recovery" | "Fully healthy", "No restrictions" | Inspection, explicit retry/recover actions, safe read-only actions | Unsafe continuation, blind resend, publish/share if the action depends on the unsafe state, and any mutating action without an explicit safe marker |
| `coordination_refused` | The runtime cannot safely continue with the prior state | "Refused", "Requires restart", "Unsafe to continue" | "Recovered", "Ready" | Diagnostics, explicit reauthorization, restart path | Any continuation or mutation that assumes prior authority or state continuity |

### First Vertical Slice

The first implementation slice should cover the surfaces where a false "ready" state is most dangerous and easiest to miss: the status popover or top-level runtime badge, the session header, and the chat input/send button. Those three surfaces must all read the same state, show the same recovery semantics, and disable the same unsafe actions. If any one of them still says "ready" while another shows recovery state, the contract is broken.

The copy rule for v1 is strict: one canonical display string per recovery state. Components may add short contextual prefixes or suffixes, but they must not invent near-synonyms like "restored", "resumed", or "healthy" for the same state. That keeps the visible contract aligned across surfaces while the plumbing is still settling.

### Task 1: Freeze the UI contract map

**Files:**
- Create: `docs/superpowers/plans/2026-06-04-runtime-truth-ui-contract-map.md`

The map must stay aligned with the actual surfaces above and with the runtime recovery labels already present in `packages/opencode/src/session/status.ts` and `packages/opencode/src/coordination/recovery.ts`.

### Task 2: Project recovery state into the highest-risk visible surfaces

**Files:**
- Modify: the embedded session UI shell entrypoints that render the status popover, session header, and chat input
- Modify: `packages/opencode/src/server/shared/ui.ts` only if the shell needs a new proxy or route boundary for the visible state

The implementation must not add a second interpretation of "ready". It should consume the recovery state once and project it into labels plus disablement rules.

### Task 3: Add a UI-facing integration test

**Files:**
- Create or modify: the UI test harness that already exercises the embedded shell or instance HTTP session routes

The test must prove the visible surfaces stay aligned. It should cover three cases: rebuilding disables send, degraded keeps inspection but blocks unsafe continuation, and refused never renders as healthy or ready.

### Task 4: Verify the contract survives teardown

**Files:**
- Extend the same UI/runtime integration test from Task 3

The test must dispose the instance, recreate it in the same process, and confirm the visible surfaces rebuild from the new runtime instead of leaking stale state from the previous one.
