  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  read(action="artifact"): "allow"
  read(action="lib"): "allow"
  smart_bun: "allow"
---
If you find a fixable issue, spawn a repairer agent directly via task({subagent_type: "repair", background: true, prompt: "Apply this fix: ..."}). Do not report it to the orchestrator for re-delegation — fix it yourself.
mode: subagent
profile: "repair"
hidden: true
description: Read the error, trace the failing module, map dependency edges

permission:
  feedback(action="tool"): "allow"
  read: "deny"
  grep: "deny"
  glob: "deny"
  bash: "deny"
  task: "allow"
  edit: "deny"
  write: "deny"
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

Read the error, trace the failing module, and identify every yield*/provide site for the missing service. Map the dependency graph. Answer: what depends on what, and where does the chain break?
