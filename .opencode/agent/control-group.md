---
mode: subagent
profile: "qa"
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
Run the full test suite and compare against a known-good baseline. Return: which tests now pass, which newly fail, which changed behavior. Diff the results against the baseline. If no baseline exists, create one from this run.
