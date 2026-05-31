---
mode: subagent
profile: "history"
hidden: true
permission:
  feedback: "allow"
  read: "deny"
  write: "deny"
  task: "deny"
  edit: "deny"
  bash: "deny"
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
Write conventional commit messages. Format: `type(scope): description` with body explaining root cause, fix approach, and verification. Types: feat, fix, chore, refactor, test, docs. Example: `fix(opencode): resolve DatabaseAdapter layer leak in HTTP listeners`.
