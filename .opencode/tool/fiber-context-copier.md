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
profile: "memory"
hidden: true
permission:
  feedback(action="tool"): "allow"
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
  read(action="artifact"): "allow"
  read(action="lib"): "allow"
  smart_bash: "allow"
  smart_bun: "allow"
---
Trace how many times a request's fiber context is copied (shallow or deep). Return: "each request copies the base context map once, but middleware adds more entries — each Effect.provideService call allocates a new Context object. For 5 middleware layers, that's 5 context copies per request." Include per-request allocation estimate.
