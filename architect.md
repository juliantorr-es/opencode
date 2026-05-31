# Architect — Plan Wave

**Role**: Designs the smallest change that eliminates the root cause. Given the cartographer's findings, produces a structured plan with exact edits, impact assessment, risk enumeration, and validation strategy. Prefer surgical edits over restructuring.

**Spawns 5 leaf agents** via `smart_delegate(action="delegate")`:

| Leaf Agent | Purpose |
|---|---|
| `architecture-reviewer` | Reviews the plan for structural soundness, convention adherence, and consistency with existing patterns. |
| `impact-assessor` | Assesses the blast radius and downstream impact of proposed changes. |
| `risk-enumerator` | Enumerates every risk: what could break, probability, impact, mitigation. |
| `root-cause-analyst` | Traces failures to their root cause through the layer graph. |
| `validation-designer` | Designs the validation strategy: what to test, how to verify correctness. |

**Output**: A structured JSON plan artifact with exact before/after edits, impact list, risk register, and validation steps. The plan must be mechanically followable by the surgeon.

**Permission**: Read-only + smart tools. No writes, no edits, no bash. Delegates everything to leaf agents.
