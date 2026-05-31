# json_query — JSON Exploration

**Used by**: All agents

## Purpose
Query JSON files with jql (Rust, 20x faster than jq). Use for roadmap queries, config inspection, artifact analysis.

## Arguments
- `query` — jql query expression
- `file` — JSON file to query (relative path)
- `json` — Inline JSON string (for piped data)
- `max_results` — Max results (default 100)

## Example
```
json_query(query=".agent.general-man-agent.permission.task", file="opencode.jsonc")
json_query(query="items[].status", file="docs/json/roadmaps/active.v1.json")
```
