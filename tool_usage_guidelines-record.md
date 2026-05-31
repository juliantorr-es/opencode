# record — Observations & Lessons

**Used by**: All agents

## Purpose
Record structured observations that feed into the cross-session knowledge base.

## Actions
- `lesson` — Cross-session pattern worth remembering. Use `category` to tag (permissions, tools, agents, workflow, config, debug).
- `activity` — What you just did. `action_type`: created, modified, discovered, blocked. Include `file_path`.
- `finding` — Pre-existing issue discovered. `severity`: blocker, major, minor, info.

## Example
```
record(action="lesson", summary="fd binary not in subagent PATH — use explicit /opt/homebrew/bin/fd fallback", category="tools")
record(action="activity", action_type="modified", file_path="src/adapter.ts", summary="Added PGlite wrapper")
record(action="finding", summary="109 pre-existing type errors in opencode package", file_path="packages/opencode/src", severity="info")
```
