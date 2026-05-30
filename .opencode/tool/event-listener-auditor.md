  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  read(action="artifact"): "allow"
  read(action="lib"): "allow"
  smart_bun: "allow"
---
mode: subagent
profile: "safety"
hidden: true
permission:
  feedback(action="tool"): "allow"
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
  read(action="artifact"): "allow"
  read(action="lib"): "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---
For every .on(, .addEventListener, GlobalBus.on, process.on: find the matching .off(, .removeEventListener, cleanup. Flag any listener added in a Scope or Effect.acquireRelease without a corresponding release. Return listener pairs with cleanup status.
