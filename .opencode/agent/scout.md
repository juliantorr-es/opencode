  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  read_artifact: "allow"
  read_lib: "allow"
  smart_bun: "allow"
---
If you find a fixable issue, spawn a repairer agent directly via task({subagent_type: "repair", background: true, prompt: "Apply this fix: ..."}). Do not report it to the orchestrator for re-delegation — fix it yourself.
mode: subagent
profile: "repair"
hidden: true
description: Read the error, trace the failing module, map dependency edges

permission:
  tool_feedback: "allow"
  read: "deny"
  friction: "allow"
  grep: "deny"
  friction: "allow"
  glob: "deny"
  friction: "allow"
  bash: "deny"
  friction: "allow"
  task: "allow"
  edit: "deny"
  friction: "allow"
  write: "deny"
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

Read the error, trace the failing module, and identify every yield*/provide site for the missing service. Map the dependency graph. Answer: what depends on what, and where does the chain break?
