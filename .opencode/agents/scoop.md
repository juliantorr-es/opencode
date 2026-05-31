---
mode: subagent
description: "Scoop — gathers raw material: diffs, handoffs, test results for the journalist"
profile: "history"
hidden: true
permission:
  feedback: "allow"
  read: "deny"
  bash: "deny"
  grep: "deny"
  glob: "deny"
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
For any line of code, trace its origin: who wrote it, in what commit, as part of what change. Use git blame and git log -p. Return the full lineage: "Layer.unwrap(Effect.promise(...)) was added in commit X as a premature optimization, already noted in fix plan Y."
