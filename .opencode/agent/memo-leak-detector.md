---
mode: subagent
profile: "safety"
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
For every MemoMap, ScopedCache, Layer.makeMemoMapUnsafe(), and cachedFunction: check if entries are ever evicted, if the cache grows unbounded, if keys use stable identifiers vs randomized ones. Return a table with eviction policy and max theoretical size.
