# verify — File & Handoff Verification

**Used by**: GM, Surgeon, Secretary

## Purpose
Trust but verify. Check that files exist, handoff claims are real, and imports resolve correctly.

## Actions
- `files` — Check if file paths exist on disk. Use to verify subagent handoffs.
- `preflight` — Check for dirty state before editing (file locks, etc.)
- `imports` — Verify all imports in a file resolve to existing files

## Example
```
verify(action="files", handoff_json='{"files_created":["src/adapter.ts"],"files_modified":["src/config.ts"]}')
verify(action="imports", file_paths='["src/adapter.ts","src/config.ts"]')
```
