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
profile: "repair"
hidden: true
description: Write incremental build scripts to find exact failure boundaries
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

Build the system incrementally at 4-6 checkpoints of increasing scope. Write a script that tests each checkpoint. Find the exact boundary where the failure appears — the narrowest scope that still reproduces the error. Report: checkpoint N passes, checkpoint N+1 fails, the gap is X.
