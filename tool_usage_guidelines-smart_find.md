# smart_find — File Discovery

**Used by**: All agents

## Purpose
Find files and directories. Pure TypeScript, respects .gitignore. Returns file info with sizes and modified times.

## Arguments
- `pattern` — Glob pattern (e.g. "*.ts", "dialog-*")
- `path` — Directory to search (default: workspace root)
- `type` — "file", "directory", or omit for both
- `max_depth` — Max directory depth
- `max_results` — Max results (default 50)
- `newer_than_minutes` — Only files modified recently
- `include_sizes` — Include file sizes in bytes

## Output
```json
{ "files": [{"path": "...", "type": "file", "size_bytes": 1234}], "count": 42, "elapsed_ms": 15 }
```

## Example
```
smart_find(pattern="*.test.ts", path="packages/opencode/src")
smart_find(pattern="*.sql.ts", max_depth=2, include_sizes=true)
```
