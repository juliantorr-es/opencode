# Multi-Lane Agentic Workflow

This rule encodes the agent orchestration model ported from the OpenCode tribunus system into native OMP agents.

## Lane Lifecycle

Complex tasks follow a multi-lane lifecycle. Each lane represents one independent feature or work item. Lanes progress concurrently — not one at a time, not sequentially through a backlog.

The lifecycle per lane: **cartographer → architect ⇄ critic (max 3 revisions) → surgeon → trial → journalist**, with a repair loop: trial issues → architect → critic → surgeon → trial (max 3 rounds).

| Phase | Agent | Role |
|---|---|---|
| 1 | cartographer | Maps the codebase: entry points, dependency graph, conventions, test infrastructure, git history |
| 2 | architect | Designs the smallest change that eliminates the root cause |
| 3 | critic | Scores the plan across 7 axes; forces revision if any axis scores too low |
| 4 | surgeon | Applies edits mechanically, verifies after each batch, reverts regressions |
| 5 | trial | Trust-nothing QA: adversarial testing, edge cases, type verification, sign-off |
| 6 | journalist | Commits, PRs, release notes — the bridge to GitHub |

## Independent Lane Advancement

Each lane advances at its own pace. When lane A's cartographer hands off, immediately launch lane A's architect — do NOT wait for lane B's cartographer. The only synchronization point is the final journalist consolidation.

## Subagent Fan-Out

Every lifecycle agent spawns leaf subagents in parallel via the `task` tool. Serial spawning is prohibited — if an agent needs multiple investigations, they launch simultaneously, not one after another.

Cartographer spawns: surveyor, diff-historian, module-grapher, test-reader
Architect spawns: root-cause-analyst, impact-assessor, risk-enumerator, validation-designer, architecture-reviewer
Critic spawns (scaled by change size): coupling-auditor, debuggability-forecaster, convergence-checker, surface-area-mapper, isolation-tester, error-trace-auditor, reversibility-checker
Surgeon spawns (per edit batch): scalpel, vitals, stress-test, second-opinion, tourniquet, monitor
Trial spawns: type-guard, lab-rat, control-group, blind-spot, fire-drill, stopwatch, sign-off, assumption-challenger, edge-case-enumerator
Journalist spawns: scoop, editor, byline, press, headline

## Adversarial Review Pattern

The critic exists specifically to force at least one design revision. Plans without adversarial review ship with unexamined assumptions. The critic's 7-axis scoring ensures:

- Coupling: no new dependencies between unrelated modules
- Debuggability: errors name the right service, fiber, and call site
- Convergence: changes move toward the target architecture, not away
- Surface area: no unintended public API changes
- Testability: every change verifiable in a 10-line script
- Error clarity: failures surface actionable messages, not silent fallbacks
- Reversibility: changes disentangle cleanly if reverted

## Verification After Every Edit

The surgeon NEVER applies a second edit until the current one is verified. After each batch: vitals (typecheck), stress-test (targeted tests), second-opinion (bisect), and monitor (side effects) run in parallel. If an edit doesn't shift the failure boundary, it gets reverted.

## Structured Handoffs

Every agent produces structured JSON output. No freeform text that requires the next agent to re-interpret. The output format is defined in each agent's system prompt. Agents consume previous artifacts, not raw source files.

## Model Assignments

| Role | Model | Why |
|---|---|---|
| cartographer, architect, surgeon | Devstral 2 | Built for SWE agentic tasks |
| critic, trial | Mistral Medium 3.5 | Top reasoning for adversarial review |
| journalist, vitals, monitor, scalpel | Mistral Small 4 | Cheap, sufficient for mechanical tasks |

## File Contention

Zero-contention lanes (touching different files) need no coordination. Lanes touching the same file resolve via produce_fragment with a consolidator assembly step before checkpoints are created.

## Commits and PRs

Follow conventional commits: `type(scope): summary`. The journalist's editor subagent groups changes by concern into logical commits. The press subagent creates the PR with before/after, linked issues, test results, and review checklist.
