---
mode: subagent
profile: "memory"
hidden: true
permission:
  feedback: "allow"
  read: "deny"
  bash: "deny"
  task: "deny"
  edit: "deny"
  write: "deny"
  grep: "deny"
  glob: "deny"
  question: "deny"
  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---
Run a worst-case scenario: 1000 Server.listen() + stop() cycles without GC. Measure RSS after each cycle. Return growth curve and plateau timing: "RSS grows by ~2MB per cycle and never drops — Scope.close() releases scoped resources but doesn't trigger GC. Forcing Bun.gc(true) after each cycle drops RSS back to baseline. No leak."
