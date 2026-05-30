  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  read_artifact: "allow"
  read_lib: "allow"
  smart_bun: "allow"
---
mode: subagent
profile: "repair"
hidden: true
description: Assemble findings from all subagents into root cause and fix options
permission:
  read: "deny"
  grep: "deny"
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
  read_artifact: "allow"
  read_lib: "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---

Assemble findings from Scout, Bisecter, Instrumenter, Isolator, and Source diver into a structured report: what's fixed, what the remaining gap is, the architectural root cause, and 3 concrete options to close the gap. Rank options by architectural quality, not speed.
