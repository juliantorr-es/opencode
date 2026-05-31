# spawn_leaf — Orchestrator's Spawn Tool

**Used by**: Cartographer, Architect, Critic, Surgeon, Trial, Journalist

## Purpose
Spawn YOUR team's leaf agents. THIS IS THE ONLY TOOL YOU USE TO SPAWN. Never use task() directly.

## What It Enforces
- **Team membership**: You can only spawn agents in YOUR team
- **Ordering (surgeon)**: Must spawn scalpel first. After scalpel completes, spawn vitals + stress-test + second-opinion + monitor in parallel
- **Ordering (journalist)**: Sequential: scoop → editor → byline → press
- **Parallel OK**: Cartographer, architect, critic, trial teams can spawn all leaf agents in parallel

## Your Team
| You | Can Spawn |
|---|---|
| cartographer | surveyor, diff-historian, module-grapher, test-reader |
| architect | architecture-reviewer, impact-assessor, risk-enumerator, root-cause-analyst, validation-designer |
| critic | convergence-checker, coupling-auditor, debuggability-forecaster, error-trace-auditor, isolation-tester, reversibility-checker, surface-area-mapper |
| surgeon | scalpel, vitals, stress-test, second-opinion, tourniquet, monitor |
| trial | lab-rat, control-group, blind-spot, fire-drill, stopwatch, type-guard, sign-off, assumption-challenger, edge-case-enumerator, state-poisoner, dependency-saboteur, security-adversary, first-responder, triage, scope, quarantine, autopsy, discharge, authority-adversary, claim-adversary, evidence-adversary, stress |
| journalist | scoop, editor, byline, press, retort, headline |

## Arguments
- `agent` — Which leaf agent to spawn (must be in your team)
- `task` — What the leaf agent should do
- `lane_id` — Lane identifier. REQUIRED.

## Example (Surgeon)
```
spawn_leaf(agent="scalpel", task="Apply edit: add yield* DatabaseAdapter.Service at sync.ts:23", lane_id="auth-fix")
// After scalpel completes, spawn verification in parallel:
spawn_leaf(agent="vitals", task="Run typecheck after scalpel edit", lane_id="auth-fix")
spawn_leaf(agent="stress-test", task="Run adapter tests after scalpel edit", lane_id="auth-fix")
spawn_leaf(agent="second-opinion", task="Run bisect to confirm boundary moved", lane_id="auth-fix")
spawn_leaf(agent="monitor", task="Watch for new errors after scalpel edit", lane_id="auth-fix")
```
