---
mode: subagent
profile: "qa"
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
For a given change, identify code paths NOT exercised by existing tests. Trace through execution paths manually. Return: "the fallback in InstanceState.context is only hit during listener build, but no test verifies request-time behavior with the fallback" — with file:line citations.
