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
description: Extract a single failing layer chain into a minimal reproduction
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

Extract a single service or layer chain into a minimal, self-contained reproduction. Write a script (bun -e one-liner, standalone test file, or minimal main) that builds just the failing layer graph and reproduces the error in isolation. Goal: prove the failure exists without the full app running.
