# smart_edit — Exact Text Replacement

**Used by**: Scalpel, Tourniquet, Handy-agent, Journalist team (editor, byline, press, retort, headline)

## Purpose
Edit files by replacing exact text. Every edit returns a diff. Use smart_batch for multi-file atomic edits.

## Arguments
- `file_path` — Path to the file (relative to worktree)
- `old_text` — Exact text to replace (must match exactly including whitespace)
- `new_text` — Replacement text
- `reason` — Why this edit is being made
- `replace_all` — Replace all occurrences (default: first only)

## Rules
- old_text must match EXACTLY — check indentation, trailing spaces, line endings
- If old_text appears multiple times, use `replace_all: true` or make it more specific
- Returns a git diff showing exactly what changed
- File must exist — use smart_write to create new files

## Example
```
smart_edit(file_path="src/sync.ts", old_text="yield* ConfigProvider.Service", new_text="yield* DatabaseAdapter.Service", reason="Add DatabaseAdapter to sync handlers")
```
