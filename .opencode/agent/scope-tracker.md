---
mode: subagent
profile: "safety"
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
For every Scope.makeUnsafe(), Effect.addFinalizer, Effect.acquireRelease, Effect.forkScoped, and ScopedCache: trace whether it gets closed/cleaned up. Pay special attention to Layer.buildWithMemoMap(layer, memoMap, scope) — who closes the scope? Return a list with closure status on success/error/interrupt paths.
