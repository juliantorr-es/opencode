  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  read(action="artifact"): "allow"
  read(action="lib"): "allow"
  smart_bun: "allow"
---
mode: subagent
profile: "repair"
hidden: true
description: Read framework internals to understand context flow through layers
permission:
  feedback(action="tool"): "allow"
  read: "deny"
  grep: "deny"
  glob: "deny"
  bash: "deny"
  edit: "deny"
  write: "deny"
  task: "deny"
  question: "deny"
  smart_edit: "allow"
  smart_write: "allow"
  smart_batch: "allow"
  smart_sd: "allow"
  read_source: "allow"
  read(action="artifact"): "allow"
  read(action="lib"): "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---

Read framework internals (node_modules, Effect source, router/middleware internals). Trace how context flows through Layer.unwrap, serve, toWebHandler, provider chains, and fiber propagation. Answer: at what exact point in the framework code does the service/layer/context get lost or dropped?
