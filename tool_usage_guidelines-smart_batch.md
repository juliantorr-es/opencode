# smart_batch — Atomic Multi-File Editor

**Used by**: Scalpel, Handy-agent, Journalist team

## Purpose
Apply multiple edits across multiple files in a single atomic operation. All edits validated first — if any fail, none are applied. Returns consolidated diff.

## Arguments
- `edits` — JSON array of `{file, oldText, newText, reason}` objects

## Validation
Before applying, all edits are checked:
1. File exists for each edit
2. oldText found exactly once in each file
3. No ambiguous matches (oldText appears multiple times)

If validation fails, ALL edits are rejected — nothing is written.

## Rollback
If a write fails mid-batch, previous edits are rolled back automatically.

## Example
```
smart_batch(edits='[{"file":"src/adapter.ts","oldText":"import { SQLite } from \"./sqlite\"","newText":"import { PGlite } from \"./pglite\"","reason":"Switch to PGlite"},{"file":"src/config.ts","oldText":"backend: \"sqlite\"","newText":"backend: \"pglite\"","reason":"Update config"}]')
```
