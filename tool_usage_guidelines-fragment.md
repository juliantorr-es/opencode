# fragment — Shared File Coordination

**Used by**: All orchestrators

## Purpose
Declare a file region you intend to modify. Used when multiple lanes might touch the same file. Never write directly to shared files — always produce a fragment first.

## Actions
- `produce` — Declare your edit region with anchor points
- `list` — See all fragments for a file (check for collisions)

## Arguments
- `file` — Target file
- `anchor_start` — Exact text before your edit (for positioning)
- `anchor_end` — Exact text after your edit
- `content` — Your replacement content
- `lane_id` — Your lane identifier

## Example
```
fragment(action="list", file="packages/opencode/src/ipc.ts")
fragment(action="produce", file="packages/opencode/src/ipc.ts", anchor_start="// IPC handlers", content="ipcMain.handle('new-handler', ...)", lane_id="ipc-fix")
```
