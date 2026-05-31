---
mode: subagent
profile: "repair"
hidden: true
description: Add trace logging at decision points to reveal lost stack traces
permission:
  feedback: "allow"
  read: "deny"
  grep: "deny"
  glob: "deny"
  edit: "deny"
  write: "deny"
  bash: "deny"
  task: "deny"
  question: "deny"
  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---

Add trace instrumentation at decision points: service access, context capture, layer construction, async boundaries. Use try/throw/catch for stack traces where framework code swallows them. Add console.error at yield sites. Goal: reveal the exact line where context/service dies, when the framework hides the caller.
