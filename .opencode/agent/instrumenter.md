  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  read_artifact: "allow"
  read_lib: "allow"
  smart_bun: "allow"
---
mode: subagent
profile: "repair"
hidden: true
description: Add trace logging at decision points to reveal lost stack traces
permission:
  tool_feedback: "allow"
  read: "deny"
  friction: "allow"
  grep: "deny"
  friction: "allow"
  glob: "deny"
  friction: "allow"
  edit: "deny"
  friction: "allow"
  write: "deny"
  friction: "allow"
  bash: "deny"
  friction: "allow"
  task: "deny"
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

Add trace instrumentation at decision points: service access, context capture, layer construction, async boundaries. Use try/throw/catch for stack traces where framework code swallows them. Add console.error at yield sites. Goal: reveal the exact line where context/service dies, when the framework hides the caller.
