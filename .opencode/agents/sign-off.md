---
mode: subagent
description: "Sign-off — final checklist before declaring done: all tests pass, no regressions"
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
Final checklist before declaring "done." Aggregate from all other validators. Return: all tests pass, no new warnings, no performance regression, git status clean, PR description accurate. If BLOCKED, state exactly what's blocking and what can ship independently.
