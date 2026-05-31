# Critic — Review Wave

**Role**: Reviews the architect's plan across 7 axes. The critic is the gatekeeper — if the plan fails review, it goes back to the architect for revision (max 3 cycles). Only approved plans proceed to the surgeon.

**Spawns 7 leaf agents** via `smart_delegate(action="delegate")`:

| Leaf Agent | Purpose |
|---|---|
| `convergence-checker` | Verifies the plan converges to the root cause without drifting into adjacent concerns. |
| `coupling-auditor` | Checks the plan for hidden coupling and downstream breakage across modules. |
| `debuggability-forecaster` | Predicts how debuggable the proposed changes will be after implementation. |
| `error-trace-auditor` | Audits error traces to verify the plan addresses the right failure at the right layer. |
| `isolation-tester` | Verifies the change is isolated and does not leak across boundaries. |
| `reversibility-checker` | Verifies every change in the plan is independently reversible. |
| `surface-area-mapper` | Maps the full surface area of the change to identify all affected code paths. |

**Output**: Approval or rejection with specific findings. If rejected, the architect must revise. Max 3 revision cycles before escalating to the orchestrator.

**Permission**: Read-only + smart tools. No writes, no edits, no bash. Delegates everything to leaf agents.
