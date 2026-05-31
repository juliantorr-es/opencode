# smart_sd — Fixed-String Replace

**Used by**: Scalpel, Handy-agent, Journalist team

## Purpose
Search and replace LITERAL text (not regex). Safer than sed — no regex escaping surprises. Use for bulk renames or simple replacements.

## Arguments
- `file` — File to modify
- `old` — Literal text to find
- `new` — Replacement text
- `reason` — Why

## Example
```
smart_sd(file="src/config.ts", old="localhost:5432", new="db.example.com:5432", reason="Update DB host")
```
