# read_source — Structured File Reading

**Used by**: All agents

## Purpose
Read a source file and return a structured digest — imports, exports, key symbols. Better than raw file reading because it parses structure.

## Arguments
- `file` — File path to read
- `symbol` — Focus on a specific symbol (function, class, type)
- `summary_only` — Return only the digest, not full content

## Example
```
read_source(file="packages/opencode/src/adapter.ts")
read_source(file="packages/opencode/src/app.ts", symbol="makeApp")
read_source(file="packages/opencode/src/config.ts", summary_only=true)
```
