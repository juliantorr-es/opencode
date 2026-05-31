# smart_grep — Content Search

**Used by**: All agents

## Purpose
Search file contents with regex. Pure TypeScript, respects .gitignore. Returns structured file:line:match results.

## Arguments
- `pattern` — Regex pattern to search for
- `path` — Directory or file to search (default: workspace root)
- `glob` — File glob filter (e.g. "*.ts", "*.md")
- `max_results` — Max results (default 30)
- `summary_only` — Return only file paths + match counts
- `context_lines` — Lines of context around each match
- `word_boundary` — Match whole words only (adds \b around pattern)

## Output
```json
{ "matches": [{"file": "...", "line": 42, "text": "..."}], "total_matches": 156, "files_with_matches": 12 }
```

## Example
```
smart_grep(pattern="DatabaseAdapter", glob="*.ts", max_results=20)
smart_grep(pattern="Layer\\.mergeAll", path="packages/opencode/src", summary_only=true)
```
