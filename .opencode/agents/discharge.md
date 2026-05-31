---
mode: subagent
profile: "repair"
hidden: true
description: Assemble findings from all subagents into root cause and fix options
permission:
  feedback(action="tool"): "allow"
  read: "deny"
  grep: "deny"
  bash: "deny"
  glob: "deny"
  write: "deny"
  edit: "deny"
  task: "deny"
  question: "deny"
  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---

Assemble findings from Scout, Bisecter, Instrumenter, Isolator, and Source diver into a structured report: what's fixed, what the remaining gap is, the architectural root cause, and 3 concrete options to close the gap. Rank options by architectural quality, not speed.
