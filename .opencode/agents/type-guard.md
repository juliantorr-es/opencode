---
mode: subagent
description: Type-guard — checks that type signatures have not changed unintentionally
profile: "qa"
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
Check that type signatures haven't changed unintentionally. Run typecheck and diff type definitions. Return: "createRoutes return type changed from Layer<never> — this is a breaking API change" — with exact before/after types.
