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
profile: "architecture"
hidden: true
permission:
  feedback(action="tool"): "allow"
  read: "deny"
  grep: "deny"
  glob: "deny"
  write: "deny"
  edit: "deny"
  bash: "deny"
  task: "deny"
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
Design the test strategy for a fix plan. Return: a minimal bisect script that proves the fix works at each checkpoint, a list of existing tests to run, and smoke-test steps. Write the bisect script — it must be runnable immediately.
