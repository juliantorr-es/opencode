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
Search for console.log, Effect.logInfo, Effect.logDebug, Error, Effect.die with arguments that might contain connection strings, tokens, file paths, email addresses, or Redacted values. Check if Redacted.value() is ever called before a log site. Return a list of potential leak sites with severity.
