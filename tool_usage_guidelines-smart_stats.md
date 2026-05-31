# smart_stats — Codebase Metrics

**Used by**: Cartographer, Architect

## Purpose
Get codebase statistics — lines of code per language, file counts, comments, blanks. Use to understand project structure at a glance.

## Arguments
- `path` — Directory to analyze (default: workspace root)
- `format` — "summary" (top 10 languages), "full" (all), "json" (raw)
- `max_languages` — Max in summary (default 10)

## Example
```
smart_stats(path="packages/opencode/src")
smart_stats(format="full")
```
