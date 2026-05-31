---
mode: subagent
description: Second-opinion — runs the bisect script to confirm the failure boundary moved
profile: "execution"
hidden: true
permission:
  feedback(action="tool"): "allow"
  read: "deny"
  bash: "deny"
  task: "deny"
  edit: "deny"
  write: "deny"
  grep: "deny"
  glob: "deny"
  question: "deny"
  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---
Run the bisect script at each checkpoint. Return: which checkpoints pass and which fail, confirming whether the edit moved the failure boundary. If the boundary didn't move, the edit was ineffective — report this clearly.
