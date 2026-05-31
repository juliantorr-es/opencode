---
mode: subagent
profile: "memory"
hidden: true
permission:
  feedback: "allow"
  read: "deny"
  bash: "deny"
  grep: "deny"
  glob: "deny"
  task: "deny"
  edit: "deny"
  write: "deny"
  question: "deny"
  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---
If there's a prior working version, compare memory profiles. Return: "before PG migration, Server.listen() RSS was 42MB; after, it's 68MB. Difference: PGlite loads the full Postgres parser (18MB static allocation) + coordination tables (8MB initial data)." Include before/after comparison with deltas and explanations.
