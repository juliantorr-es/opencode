# replace_symbol — AST-Aware Rename

**Used by**: Ground workers

## Purpose
Rename a symbol using AST-aware matching. Only replaces real identifier references — skips strings, comments, partial matches. Safer than search-and-replace for renames.

## Arguments
- `file` — File to modify
- `old_symbol` — Symbol to rename
- `new_symbol` — New name
- `reason` — Why

## Example
```
replace_symbol(file="src/adapter.ts", old_symbol="oldAdapter", new_symbol="pgliteAdapter", reason="Rename for clarity")
```
