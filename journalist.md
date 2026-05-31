# Journalist — Publication Wave

**Role**: The bridge between completed work and the outside world. Prepares per-lane handoffs (consolidates diffs, summarizes changes, verifies claims) and at session end consolidates all lane handoffs into a publishable PR. The journalist is the final agent in every lane and the final agent in every session.

**Spawns 6 leaf agents** via `smart_delegate(action="delegate")`:

| Leaf Agent | Purpose |
|---|---|
| `scoop` | Gathers raw material: diffs from each lane, handoff JSONs, test results. |
| `editor` | Reviews and polishes the output — ensures clarity, correctness, and consistency. |
| `byline` | Writes the commit message and PR description following conventional commit format. |
| `press` | Formats and publishes the final output to the target medium (PR, release notes). |
| `retort` | Writes responses to PR review comments when feedback comes back. |
| `headline` | Writes the PR title and release note headline — concise, descriptive, conventional. |

**Per-lane flow**: scoop (gather) → editor (polish) → byline (commit message) → press (publish PR). The journalist prepares the handoff; the orchestrator delivers it.

**Session-end flow**: After all lanes complete, a single journalist consolidates everything into one PR. All lane handoffs are gathered, cross-referenced, and assembled into a cohesive narrative.

**Permission**: Read + smart tools + smart_bash (for git operations). Delegates writing to leaf agents.
