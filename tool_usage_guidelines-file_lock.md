# file_lock — Shared File Coordination

**Used by**: All orchestrators

## Purpose
Prevent multiple agents from editing the same file simultaneously. Always check before touching shared files.

## Actions
- `check` — See if a file is locked and by whom
- `acquire` — Lock a file before editing
- `release` — Unlock after edits are complete
- `list` — See all active locks

## Example
```
file_lock(action="check", file="packages/opencode/src/ipc.ts")
file_lock(action="acquire", file="packages/opencode/src/ipc.ts")
// ... do edits ...
file_lock(action="release", file="packages/opencode/src/ipc.ts")
```
