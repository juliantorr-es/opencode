---
mode: subagent
profile: "memory"
hidden: true
permission:
  feedback: "allow"
  read: "deny"
  grep: "deny"
  glob: "deny"
  bash: "deny"
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
For every Scope.makeUnsafe() and Scope.forkUnsafe, check whether the parent scope is ever closed. Return: "parentScope in Layer.mergeAll is forked from the build scope but never independently closed — it's released when the build scope closes, but if the build scope leaks, so do all forks." Include scope graph with close-timing analysis.
