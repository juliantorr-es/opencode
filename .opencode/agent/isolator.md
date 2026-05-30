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
description: Extract a single failing layer chain into a minimal reproduction
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

Extract a single service or layer chain into a minimal, self-contained reproduction. Write a script (bun -e one-liner, standalone test file, or minimal main) that builds just the failing layer graph and reproduces the error in isolation. Goal: prove the failure exists without the full app running.
