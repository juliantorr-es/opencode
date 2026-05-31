# lane_spawn — GM's Spawn Tool

**Used by**: General Man-agent only

## Purpose
Spawn lifecycle agents (cartographer, architect, critic, surgeon, trial, journalist) and handy-agent. THIS IS THE ONLY TOOL THE GM USES TO SPAWN AGENTS. Never use task() directly.

## What It Enforces
- **Lane ordering**: You cannot spawn architect for lane A until cartographer for lane A has completed. Each lane advances independently.
- **Repair loop**: After trial fails, set `repair: true` to spawn architect → critic → surgeon → trial again (max 3 rounds).
- **Handy-agent**: Always allowed, bypasses ordering (quick fixes).

## Arguments
- `agent` — Which lifecycle agent to spawn (cartographer, architect, critic, surgeon, trial, journalist, handy-agent)
- `task` — What the agent should do (be specific with file paths and expected output)
- `lane_id` — Lane identifier. REQUIRED. Keep the same lane_id for all agents in one lane.
- `repair` — Set to true if this is a repair spawn (trial found issues)

## Output
Returns the exact `task()` command to copy-paste. Always use `background: true`.

## Example
```
lane_spawn(agent="cartographer", task="Map the auth module — entry points, dependencies, conventions", lane_id="auth-fix")
lane_spawn(agent="architect", task="Design fix for auth bypass — use cartographer findings", lane_id="auth-fix")
lane_spawn(agent="surgeon", task="Apply the approved plan for auth fix", lane_id="auth-fix")
lane_spawn(agent="trial", task="Validate auth fix changes", lane_id="auth-fix")
lane_spawn(agent="journalist", task="Prepare handoff for auth fix", lane_id="auth-fix")
```
