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
profile: "qa"
hidden: true
permission:
  feedback(action="tool"): "allow"
  read: "deny"
  write: "deny"
  edit: "deny"
  bash: "deny"
  grep: "deny"
  glob: "deny"
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
Design new tests that exercise the fix in the project's test framework. Write test cases that specifically target the root cause. Return: test file content and the exact command to run it. Tests must fail before the fix and pass after.
