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
description: Write incremental build scripts to find exact failure boundaries
permission:
  tool_feedback: "allow"
  read: "deny"
  friction: "allow"
  grep: "deny"
  friction: "allow"
  glob: "deny"
  friction: "allow"
  write: "deny"
  friction: "allow"
  edit: "deny"
  friction: "allow"
  bash: "deny"
  friction: "allow"
  task: "deny"
  friction: "allow"
  question: "deny"
  friction: "allow"
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

Build the system incrementally at 4-6 checkpoints of increasing scope. Write a script that tests each checkpoint. Find the exact boundary where the failure appears — the narrowest scope that still reproduces the error. Report: checkpoint N passes, checkpoint N+1 fails, the gap is X.
