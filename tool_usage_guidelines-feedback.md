# feedback — Friction & Failure Reporting

**Used by**: All agents

## Purpose
Report tool friction, failures, or behavioral issues. Severity-based routing.

## Actions
- `friction` — Behavioral issues, workflow problems
- `tool` — Tool-specific feedback
- `failure` — Tool crashes or errors

## Severity Levels
- `blocker` — Lane halted, needs escalation
- `major` — Needs attention, tracked cross-session
- `minor` — Noted for later
- `annoyance` — Logged, no action needed

## Example
```
feedback(action="failure", tool_name="smart_grep", severity="major", note="rg binary not found in subagent", expected="Search results", actual="fd not available error", workaround="Used smart_find instead")
```
