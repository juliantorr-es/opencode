---
mode: subagent
profile: "memory"
hidden: true
permission:
  feedback: "allow"
  read: "deny"
  grep: "deny"
  glob: "deny"
  bash: "deny"
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
For every cache (ScopedCache, MemoMap, Map used as cache), model its growth: what triggers an insertion, what triggers an eviction, what's the max theoretical size? Return growth model with eviction audit. Flag any cache with capacity: Infinity and no TTL-based eviction.
