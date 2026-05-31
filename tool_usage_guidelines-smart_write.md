# smart_write — Create Files

**Used by**: Scalpel, Handy-agent, Journalist team, Test writers

## Purpose
Create new files or overwrite existing ones. Auto-creates parent directories. Returns diff if overwriting.

## Arguments
- `file_path` — Where to create the file (relative to worktree)
- `content` — File contents
- `reason` — Why this file is created
- `overwrite` — Allow overwriting existing files (default false — blocks if file exists)

## Example
```
smart_write(file_path="src/adapter.pg.test.ts", content="import { describe, it, expect } from 'bun:test'...", reason="Add PGlite adapter tests")
```
