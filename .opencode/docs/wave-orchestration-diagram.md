```
                   ┌─────────────────────────────────────────────────────────────────────┐
                   │                        ORCHESTRATOR                                  │
                   │  reads state → fans out waves → collects results → advances gates    │
                   └─────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                          │
│  WAVE 1: LEARNING                                                                        │
│  ┌──────────────┐                                                                        │
│  │ cartographer │──→ task({background:true}) x5 ──┐                                      │
│  └──────────────┘                                  │                                      │
│       │                                            ▼                                      │
│       │         ┌─────────────────┬────────────────┬──────────────┬──────────────┐       │
│       │         │ surface-mapper  │ module-grapher │convention-   │  test-reader  │diff-  │
│       │         │                 │                │   scout      │               │historian
│       │         │ entry points    │ dependency     │ 5 examples   │ fixtures      │ delta  │
│       │         │ aliases, pkgs   │ graph, cycles  │ of patterns  │ env vars      │ broken→│
│       │         └─────────────────┴────────────────┴──────────────┴──────────────┘working │
│       │                                  │                                               │
│       ▼                                  ▼                                               │
│  cartographer output:  entry map · dep graph · conventions · test infra · smoking guns    │
│                                                                                          │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  WAVE 2: PLAN                                                                            │
│  ┌─────────────┐   ┌──────────────────────────────────────────────────────────────┐      │
│  │  architect  │   │                       CRITIC (plan reviewer)                  │      │
│  │             │   │  scores plan on 7 axes: coupling, debuggability, convergence, │      │
│  │ designs fix │──→│  surface area, testability, error clarity, reversibility     │      │
│  │ ranked opts │   │                                                              │      │
│  └─────────────┘   │  subagents: coupling-auditor · debuggability-forecaster      │      │
│       │            │             convergence-checker · surface-area-mapper         │      │
│       │            │             isolation-tester · error-trace-auditor            │      │
│       ▼            │             reversibility-checker                             │      │
│  architect output: │                                                              │      │
│  root causes       │  verdict: APPROVE / APPROVE WITH CONDITIONS / REJECT          │      │
│  fix plan JSON     └──────────────────────────────────────────────────────────────┘      │
│  impact + risk          │                                                                 │
│  validation steps       ▼                                                                 │
│                    ┌─────────────┐                                                        │
│                    │ GATE:       │                                                        │
│                    │ plan_approval│── REJECT → back to architect                          │
│                    │ .v1.json    │── APPROVE → WAVE 3                                    │
│                    └─────────────┘                                                        │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  WAVE 3: EXECUTION                                                                       │
│  ┌────────────┐                                                                          │
│  │  executor  │──→ applies edits MECHANICALLY, 1 edit per verification cycle             │
│  └────────────┘                                                                          │
│       │                                                                                  │
│       │  per edit:                                                                       │
│       │  ┌──────────────┐   ┌────────────┐   ┌──────────────┐   ┌───────────┐           │
│       │  │type-checker  │   │test-runner │   │bisect-verif.│   │log-watcher│           │
│       │  │              │   │            │   │              │   │           │           │
│       │  │ bun typecheck│   │ run target │   │ boundary     │   │ diff error│           │
│       │  │              │   │ test       │   │ moved?       │   │ messages  │           │
│       │  └──────────────┘   └────────────┘   └──────────────┘   └───────────┘           │
│       │                                  │                                               │
│       │  if edit doesn't move boundary → ┌─────────────┐                                  │
│       │                                  │revert-guard │ revert + report                  │
│       │                                  └─────────────┘                                  │
│       ▼                                                                                  │
│  executor output:  edit log · verification results · failure boundary map                │
│                                                                                          │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  WAVE 4: QA & VALIDATION                                                                 │
│  ┌────────────┐                                                                          │
│  │ validator  │──→ task({background:true}) x7 ──┐                                        │
│  └────────────┘                                  │                                        │
│       │                                          ▼                                        │
│       │         ┌────────────┬───────────┬──────────┬──────────┬──────────┬──────────┐   │
│       │         │test-designer│regression-│coverage- │smoke-test│perform.  │contract- │   │
│       │         │            │ scanner   │ mapper   │ runner   │sentinel  │verifier  │   │
│       │         │ new tests  │ full suite│ uncovered│ e2e user │ timing   │ type sig │   │
│       │         │ for fix    │ vs baseline│paths    │ scenarios│ vs base  │ changes  │   │
│       │         └────────────┴───────────┴──────────┴──────────┴──────────┴──────────┘   │
│       │                                  │                                               │
│       │                                  ▼                                               │
│       │                          ┌───────────────┐                                       │
│       │                          │acceptance-gate│                                       │
│       │                          │               │                                       │
│       │                          │ all pass? → W5│                                       │
│       │                          │ BLOCKED → W6  │                                       │
│       │                          └───────────────┘                                       │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  WAVE 5: STRESS (RED TEAM)                                                               │
│  ┌──────────┐                                                                            │
│  │  stress  │──→ task({background:true}) x6 ──┐                                          │
│  └──────────┘                                  │                                          │
│       │                                        ▼                                          │
│       │     ┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────────────┐  │
│       │     │edge-case │  state   │dependency│concurren.│  memory  │  assumption      │  │
│       │     │enumerator│ poisoner │ saboteur │ stresser │leak-hunt.│  challenger      │  │
│       │     │          │          │          │          │          │                  │  │
│       │     │ nulls,   │ test     │ bad env  │ parallel │ repeated │ prove/disprove   │  │
│       │     │ races,   │ lifecycle│ vars,    │ listen() │ cycles   │ every explicit   │  │
│       │     │ restarts │ leaks    │ unreach. │ calls    │ memo map │ assumption       │  │
│       │     └──────────┴──────────┴──────────┴──────────┴──────────┴──────────────────┘  │
│       │                                  │                                               │
│       ▼                                  ▼                                               │
│  stress findings ──→ any blockers? ──YES──→ ┌─────────────────┐                          │
│                         │                   │ GATE:            │                          │
│                         NO                  │ red_team_approval│                          │
│                         │                   │ .v1.json         │                          │
│                         ▼                   └────────┬────────┘                          │
│                      W7 (historian)                  │                                    │
│                                                     ▼                                    │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  WAVE 6: REPAIR (only if stress/QA found blockers)                                       │
│                                                                                          │
│  architect designs repair plan ──→ critic reviews on 7 axes ──→ APPROVE?                │
│       │                                                         │                        │
│       │                                                    NO ──┘ YES                    │
│       │                                                              │                    │
│       │                                              ┌───────────────▼──────────────┐     │
│       │                                              │  repair_plan_approval.v1.json │     │
│       │                                              └───────────────┬──────────────┘     │
│       │                                                              │                    │
│       ▼                                                              ▼                    │
│  ┌──────────┐                                                                            │
│  │  repair  │──→ task({background:true}) x6 ──┐  (executes architect's plan,            │
│  └──────────┘                                  │   does NOT design repairs)              │
│       │                                        ▼                                          │
│       │     ┌────────┬──────────┬──────────┬──────────┬──────────────┬────────────┐      │
│       │     │ scout  │ bisecter │instrumen.│ isolator │ source-diver │synthesizer │      │
│       │     │        │          │          │          │              │            │      │
│       │     │ trace  │ build    │ add      │ minimal  │ read         │ assemble   │      │
│       │     │ module │ checkpts │ trace    │ repro    │ framework    │ root cause │      │
│       │     └────────┴──────────┴──────────┴──────────┴──────────────┴────────────┘      │
│       │                                  │                                               │
│       │  repair applied → re-enter W4 (validation) then W5 (stress)                      │
│       │  max 5 repair cycles → escalate on 6th                                           │
│                                                                                          │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  WAVE 7: DOCUMENTATION                                                                   │
│  ┌─────────────┐                                                                         │
│  │  historian  │──→ task({background:true}) x6 ──┐                                       │
│  └─────────────┘                                  │                                       │
│       │                                           ▼                                       │
│       │       ┌──────────┬──────────┬──────────┬───────────┬──────────┬───────────┐      │
│       │       │  blame   │   diff   │ message  │    PR     │  review  │ release   │      │
│       │       │  tracer  │ composer │  writer  │  crafter  │responder │note-writer│      │
│       │       │          │          │          │           │          │           │      │
│       │       │ lineage  │ group by │convent.  │ gh pr     │ handle   │ changelog │      │
│       │       │ of code  │ concern  │ commits  │ create    │ comments │ entries   │      │
│       │       └──────────┴──────────┴──────────┴───────────┴──────────┴───────────┘      │
│       │                                  │                                               │
│       ▼                                  ▼                                               │
│  ┌──────────────┐              ┌──────────────────┐                                       │
│  │ chronology   │              │  logical commits │                                       │
│  │ state machine│              │  PR description  │                                       │
│  │              │              │  release notes   │                                       │
│  │ 1. code only │              └──────────────────┘                                       │
│  │ 2. yield     │                                                                         │
│  │ 3. audit JSON│                                                                         │
│  │ 4. commit    │                                                                         │
│  └──────────────┘                                                                         │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────┐
                              │       REPORT + FREEZE        │
                              │  synthesizer assembles final │
                              │  session report from all     │
                              │  wave artifacts              │
                              └─────────────────────────────┘


═══════════════════════════════════════════════════════════════════════════════════════════
                                TURN-BY-TURN RHYTHM
═══════════════════════════════════════════════════════════════════════════════════════════

  TURN N:   orchestrator checks read_messages ONCE → any completed subagents?
            if WAVE complete → advance gate
            fan out ALL independent delegations for current wave via task({background:true})
            STOP — do not poll, do not wait

  TURN N+1: background tasks deliver results as <task id="..." state="completed">
            orchestrator reads results, advances wave, fans out next wave
            STOP

  ── No idle looping. No serial delegation. Results arrive asynchronously. ──


═══════════════════════════════════════════════════════════════════════════════════════════
                                  APPROVAL GATES
═══════════════════════════════════════════════════════════════════════════════════════════

  W2 → W3:   plan_approval.v1.json         (critic must APPROVE before executor runs)
  W5 → W6:   red_team_approval.v1.json     (stress findings admitted → architect designs repair)
  W6 entry:  repair_plan_approval.v1.json  (critic must APPROVE repair plan before repair executes)
  W6 → W4:   repair complete → re-validate

  All gates are file-backed JSON artifacts under docs/json/opencode/approvals/


═══════════════════════════════════════════════════════════════════════════════════════════
                               CHRONOLOGY STATE MACHINE
═══════════════════════════════════════════════════════════════════════════════════════════

  state 1: commit CODE changes only → Candidate Checkpoint
  state 2: yield to Auditor (wait for audit)
  state 3: receive Audit JSON
  state 4: commit Audit JSON as discrete, subsequent layer

  NEVER bundle code and evidence in the same commit.
```
