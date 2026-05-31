# smart_session — Session Lifecycle

**Used by**: GM

## Purpose
Manage the session lifecycle. One tool for everything session-related.

## Actions
- `init` — Initialize a new session (loads roadmap, checks environment)
- `suggest` — Cross-reference lessons, friction, bugs, findings into prioritized recommendations
- `curate` — Curate context after a wave completes
- `diff` — Consolidated change summary
- `end` — Archive session with summary

## Example
```
smart_session(action="suggest")
smart_session(action="init")
smart_session(action="curate")
smart_session(action="end", summary="Fixed auth bypass and PGlite adapter")
```
