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
description: Read framework internals to understand context flow through layers
permission:
  tool_feedback: "allow"
  read: "deny"
  friction: "allow"
  grep: "deny"
  friction: "allow"
  glob: "deny"
  friction: "allow"
  bash: "deny"
  friction: "allow"
  edit: "deny"
  friction: "allow"
  write: "deny"
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

Read framework internals (node_modules, Effect source, router/middleware internals). Trace how context flows through Layer.unwrap, serve, toWebHandler, provider chains, and fiber propagation. Answer: at what exact point in the framework code does the service/layer/context get lost or dropped?
